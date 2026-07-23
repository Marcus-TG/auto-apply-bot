/**
 * Inbound-reply sweep. The n8n "reply sweep" workflow asks /reply-sweep/query
 * for a Gmail search covering every company we've submitted to, fetches the
 * matching messages, and POSTs them to /reply-sweep. This module matches each
 * message to a submitted job, classifies it, advances the followups status the
 * Sent tab renders, and returns the updates for the Discord digest.
 *
 * Classification runs on the local model (MODEL_PREFILTER — free at the margin,
 * a handful of short emails per day). The keyword heuristics remain as the
 * fallback when the local endpoint is down, so the sweep never silently skips
 * a day. Either way, only clear signals move the status; anything ambiguous is
 * surfaced as an "update" with no status change so the human stays the arbiter.
 */
import { z } from "zod";
import { config } from "../config/index.js";
import { callStructured } from "../llm/client.js";
import { db } from "../store/db.js";
import { jobs, submissions, followups, events, type FollowupStatus } from "../store/repositories.js";

export interface SweepMessage {
  id?: string;
  sender?: string;
  subject?: string;
  snippet?: string;
  date?: string;
}

export interface SweepUpdate {
  jobId: string;
  company: string;
  title: string;
  classification: string;
  statusBefore: string;
  statusAfter: string;
  sender: string;
  subject: string;
  snippet: string;
}

const ATS_SENDER_DOMAINS = [
  "greenhouse-mail.io",
  "greenhouse.io",
  "ashbyhq.com",
  "myworkday.com",
  "workablemail.com",
  "workable.com",
  "applytojob.com",
  "bamboohr.com",
  "lever.co",
  "smartrecruiters.com",
  "icims.com",
];

/** "Tecsys Inc." -> "tecsys"; "Grafana Labs" -> "grafana"; "Lemon.io" -> "lemon.io" */
function companyToken(company: string): string {
  const cleaned = company
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|co|labs|technologies|technology)\b\.?/g, "")
    .trim();
  return (cleaned.split(/\s+/)[0] || company.toLowerCase()).replace(/[^a-z0-9.]/g, "");
}

function submittedJobs(): { jobId: string; company: string; title: string; token: string }[] {
  return submissions
    .all()
    .map((s) => {
      const job = jobs.get(s.job_id);
      return job
        ? { jobId: s.job_id, company: job.company, title: job.title, token: companyToken(job.company) }
        : null;
    })
    .filter((j): j is NonNullable<typeof j> => j !== null);
}

/** Gmail search covering ATS senders + every submitted company, last `days` days. */
export function buildSweepQuery(days = 2): string {
  const names = [...new Set(submittedJobs().map((j) => `"${j.company.replace(/"/g, "")}"`))];
  const froms = ATS_SENDER_DOMAINS.map((d) => `from:${d}`);
  return `newer_than:${days}d -in:sent -in:draft {${[...froms, ...names].join(" ")}}`;
}

// Never surface these: operational mail that isn't a reply about a candidacy.
const NOISE =
  /security code|verification code|verify your email|receipt from|invoice|payment|billing|unsubscribe from|password reset|reset your password/i;
// Application-received autoresponders; already tracked at submit time. Only a
// heuristic-fallback signal — rejections often open with the same "thank you
// for applying" phrasing, so this must never pre-drop a message from the model.
const CONFIRMATION =
  /(received|got) your application|application (was|has been|is) (submitted|received|in)|thank(s| you) for (applying|your application|submitting)|successfully received your application|confirmation of application/i;

const REJECTED =
  /unfortunately|not (be )?moving forward|will not be proceeding|other candidates|not to (move|proceed)|no longer (under consideration|being considered)|decided to (pursue|proceed|move forward) with other|regret to inform|not selected|not a (match|fit) at this time|won'?t be (progressing|moving)|don'?t have projects that would match/i;
const OFFER = /offer letter|pleased to (extend|offer)|extend(ing)? an offer/i;
const INTERVIEW = /interview/i;
const SCREENING =
  /schedule (a )?(call|chat|time|meeting)|book (a |some )?(time|call)|your availability|would love to (chat|connect|speak|talk)|set up a (call|chat|conversation)|next steps? (call|chat|conversation)|phone screen/i;

type Classification = "rejected" | "offer" | "interview" | "screening" | "update";
type LlmClassification = Classification | "confirmation" | "unrelated";

function classifyHeuristic(text: string): LlmClassification {
  if (REJECTED.test(text)) return "rejected";
  if (OFFER.test(text)) return "offer";
  if (INTERVIEW.test(text)) return "interview";
  if (SCREENING.test(text)) return "screening";
  if (CONFIRMATION.test(text)) return "confirmation";
  return "update";
}

const ReplyVerdict = z.object({
  classification: z.enum([
    "rejected",
    "offer",
    "interview",
    "screening",
    "update",
    "confirmation",
    "unrelated",
  ]),
  reason: z.string(),
});

const CLASSIFY_SYSTEM = `You triage emails for a job-application tracker. Given one email and the
application it was matched to, decide what the email means for that candidacy:
- rejected: the company is declining or closing the candidacy ("not moving forward", "other candidates", role closed).
- offer: an actual job offer is being made or an offer letter discussed.
- interview: an invitation to a formal interview (technical, panel, onsite, take-home debrief).
- screening: an invitation to a first recruiter call / phone screen / scheduling link to "chat".
- update: genuinely about this candidacy but none of the above (e.g. "still reviewing", timeline updates).
- confirmation: an automated application-received acknowledgement or receipt.
- unrelated: not about this application at all (marketing, product news, billing, a different role/company).
Judge from content, not politeness: warm rejections still say no. When torn between two
status-moving labels, pick the weaker one; when torn between update and a status change, pick update.`;

async function classifyLlm(
  msg: { sender: string; subject: string; snippet: string },
  job: { company: string; title: string },
): Promise<{ classification: LlmClassification; reason: string; via: "local" | "heuristic" }> {
  try {
    const verdict = await callStructured({
      model: config.env.modelPrefilter,
      system: CLASSIFY_SYSTEM,
      userPrompt: [
        `Application: ${job.title} at ${job.company}`,
        `From: ${msg.sender}`,
        `Subject: ${msg.subject}`,
        `Body snippet: ${msg.snippet || "(empty)"}`,
      ].join("\n"),
      tool: {
        name: "classify_reply",
        description: "Classify what this email means for the matched job application.",
        schema: ReplyVerdict,
      },
      maxTokens: 300,
    });
    return { ...verdict, via: "local" };
  } catch {
    const c = classifyHeuristic(`${msg.subject} ${msg.snippet}`);
    return { classification: c, reason: "local model unavailable; keyword fallback", via: "heuristic" };
  }
}

// Forward-only pipeline rank; rejected is terminal and always applies.
const RANK: Record<FollowupStatus, number> = {
  applied: 0,
  no_response: 0,
  screening: 1,
  interview: 2,
  offer: 3,
  rejected: 4,
};

function alreadyProcessed(messageId: string): boolean {
  return !!db()
    .prepare(`SELECT 1 FROM events WHERE kind='inbound_reply' AND data LIKE ?`)
    .get(`%"messageId":"${messageId}"%`);
}

/** Match a message to at most one submitted job. Sender-domain hits outrank subject hits. */
function matchJob(
  sender: string,
  subject: string,
  candidates: ReturnType<typeof submittedJobs>,
): (typeof candidates)[number] | null {
  const senderLower = sender.toLowerCase();
  let best: { job: (typeof candidates)[number]; score: number } | null = null;
  for (const job of candidates) {
    if (!job.token) continue;
    let score = 0;
    if (senderLower.includes(job.token)) score += 2;
    if (new RegExp(`\\b${job.token.replace(/\./g, "\\.")}\\b`, "i").test(subject)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { job, score };
  }
  return best?.job ?? null;
}

export async function processSweep(messages: SweepMessage[]): Promise<{
  received: number;
  matched: SweepUpdate[];
}> {
  const candidates = submittedJobs();
  const updates: SweepUpdate[] = [];

  for (const m of messages) {
    const sender = m.sender ?? "";
    const subject = m.subject ?? "";
    const snippet = m.snippet ?? "";
    const text = `${subject} ${snippet}`;
    const messageId = m.id ?? "";

    if (messageId && alreadyProcessed(messageId)) continue;
    if (NOISE.test(text)) continue;

    const job = matchJob(sender, subject, candidates);
    if (!job) continue;

    const verdict = await classifyLlm({ sender, subject, snippet }, job);
    const { classification } = verdict;

    const before: FollowupStatus = followups.get(job.jobId)?.status ?? "applied";
    let after = before;
    if (classification !== "update" && classification !== "confirmation" && classification !== "unrelated") {
      const target = classification as FollowupStatus;
      if (target === "rejected" || RANK[target] > RANK[before]) after = target;
    }
    if (after !== before) {
      followups.set(job.jobId, after, `${new Date().toISOString().slice(0, 10)}: ${subject}`.slice(0, 300));
    }
    // Log every model-triaged message (incl. confirmation/unrelated) so the
    // 2-day search overlap never re-classifies the same email.
    events.log({
      jobId: job.jobId,
      kind: "inbound_reply",
      data: {
        messageId,
        sender,
        subject,
        classification,
        reason: verdict.reason,
        via: verdict.via,
        statusBefore: before,
        statusAfter: after,
      },
    });
    if (classification === "confirmation" || classification === "unrelated") continue;

    updates.push({
      jobId: job.jobId,
      company: job.company,
      title: job.title,
      classification,
      statusBefore: before,
      statusAfter: after,
      sender,
      subject,
      snippet: snippet.slice(0, 400),
    });
  }

  return { received: messages.length, matched: updates };
}
