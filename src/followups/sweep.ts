/**
 * Inbound-reply sweep. The n8n "reply sweep" workflow asks /reply-sweep/query
 * for a Gmail search covering every company we've submitted to, fetches the
 * matching messages, and POSTs them to /reply-sweep. This module matches each
 * message to a submitted job, classifies it, advances the followups status the
 * Sent tab renders, and returns the updates for the Discord digest.
 *
 * Classification is deliberately heuristic: clear signals move the status,
 * anything ambiguous is surfaced as an "update" with no status change so the
 * human stays the arbiter.
 */
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
// Application-received autoresponders; already tracked at submit time.
const CONFIRMATION =
  /(received|got) your application|application (was|has been|is) (submitted|received|in)|thank(s| you) for (applying|your application|submitting)|successfully received your application|confirmation of application/i;

const REJECTED =
  /unfortunately|not (be )?moving forward|will not be proceeding|other candidates|not to (move|proceed)|no longer (under consideration|being considered)|decided to (pursue|proceed|move forward) with other|regret to inform|not selected|not a (match|fit) at this time|won'?t be (progressing|moving)|don'?t have projects that would match/i;
const OFFER = /offer letter|pleased to (extend|offer)|extend(ing)? an offer/i;
const INTERVIEW = /interview/i;
const SCREENING =
  /schedule (a )?(call|chat|time|meeting)|book (a |some )?(time|call)|your availability|would love to (chat|connect|speak|talk)|set up a (call|chat|conversation)|next steps? (call|chat|conversation)|phone screen/i;

type Classification = "rejected" | "offer" | "interview" | "screening" | "update";

function classify(text: string): Classification {
  if (REJECTED.test(text)) return "rejected";
  if (OFFER.test(text)) return "offer";
  if (INTERVIEW.test(text)) return "interview";
  if (SCREENING.test(text)) return "screening";
  return "update";
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

export function processSweep(messages: SweepMessage[]): {
  received: number;
  matched: SweepUpdate[];
} {
  const candidates = submittedJobs();
  const updates: SweepUpdate[] = [];

  for (const m of messages) {
    const sender = m.sender ?? "";
    const subject = m.subject ?? "";
    const snippet = m.snippet ?? "";
    const text = `${subject} ${snippet}`;
    const messageId = m.id ?? "";

    if (messageId && alreadyProcessed(messageId)) continue;
    if (NOISE.test(text) || CONFIRMATION.test(text)) continue;

    const job = matchJob(sender, subject, candidates);
    if (!job) continue;

    const classification = classify(text);
    const before: FollowupStatus = followups.get(job.jobId)?.status ?? "applied";
    let after = before;
    if (classification !== "update") {
      const target = classification as FollowupStatus;
      if (target === "rejected" || RANK[target] > RANK[before]) after = target;
    }
    if (after !== before) {
      followups.set(job.jobId, after, `${new Date().toISOString().slice(0, 10)}: ${subject}`.slice(0, 300));
    }
    events.log({
      jobId: job.jobId,
      kind: "inbound_reply",
      data: { messageId, sender, subject, classification, statusBefore: before, statusAfter: after },
    });
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
