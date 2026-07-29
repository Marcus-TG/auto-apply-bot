/**
 * Refinement pass: re-rank the human review queue by realistic odds of getting
 * HIRED, which is a different question than fit. The fit scorer asks "could the
 * candidate do this job?"; this pass asks "of the jobs that cleared that bar,
 * which applications are most likely to convert?" — hard requirement gates the
 * candidate can't argue past, how crowded the applicant pool looks, how stale
 * the posting is, and whether the candidate's shipped work is direct proof for
 * this exact role. Runs once per job on the local model; the queue board sorts
 * by the result.
 */
import { z } from "zod";
import { config } from "../config/index.js";
import { callStructured } from "../llm/client.js";
import { jobs, scores, refinements, events, type Refinement } from "../store/repositories.js";
import { bucketOf, trackRecordBlock } from "./track-record.js";
import type { JobPosting } from "../types/index.js";

const RefineOutput = z.object({
  odds: z.number().min(0).max(100),
  edge: z.string(),
  degreeGated: z.boolean(),
  competition: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

const SYSTEM = `You estimate a specific candidate's realistic odds of being HIRED for postings
that already passed a fit screen. Fit is necessary but not sufficient — rank by conversion odds.

Weigh, in rough order of importance:
1. Hard gates. A degree/certification requirement stated as mandatory with no "or equivalent
   experience" language is a major penalty for this candidate (self-taught, no degree, strong
   shipped-work portfolio). Set degreeGated=true ONLY for such hard requirements; "preferred"
   or "or equivalent" language is not a gate. Same logic for clearances, licenses, must-be-located-in.
2. Proof match. Odds rise sharply when the candidate's concrete shipped work (workflow automation,
   n8n orchestration, self-hosted LLM/AI systems, browser automation, marketing operations for his
   own companies) is direct evidence for the role's core duty — a portfolio can win those arguments.
   Odds fall when the role's core duty is something the candidate can only claim, not show.
3. Competition. Judge the pool MECHANICALLY, not by how niche the team sounds:
   famous/public/household-name company + fully remote = high, always — a "special innovation lab"
   inside a famous company still gets that company's applicant flood. competition=low is reserved
   for small or little-known companies, hybrid/onsite outside major hubs, or genuinely obscure niches.
4. Seniority reach. Senior/Staff/Principal/Director titles at large or famous companies are a reach
   for this early-career candidate REGARDLESS of skill overlap — proof match never cancels an
   experience-scale mismatch. Stay consistent with the fit scorer's gap list you are given: gaps
   like "team leadership", "at scale", or "X+ years" mean the seniority penalty applies.
5. Freshness. Postings older than ~45 days likely have deep pipelines or are stale.
6. Observed outcomes. When given a track record of applications already sent, use it to rank
   postings RELATIVE to each other: categories that keep getting screened out within days
   should fall BELOW comparable postings from categories that don't. It is evidence about
   target selection, not proof that everything is hopeless — a uniformly low spread is a
   failed ranking. Never penalize a category the candidate simply hasn't applied to yet;
   untested is not failed, and those are judged on the posting alone.

odds is a 0-100 ranking signal, not a literal probability. Spread scores out — if everything
lands 40-60 the ranking is useless. Before returning anything above 70, re-verify each factor
against the posting text — high scores must survive skepticism, not enthusiasm. edge = ONE
concrete sentence naming the candidate's best argument for THIS role (or the biggest obstacle
if odds are low).`;

export async function refineJob(
  job: JobPosting & { status?: string },
  profile: unknown,
  /** Precomputed track record — pass it when refining a batch so the outcome
   *  query runs once instead of once per job. */
  trackRecord?: string | null,
): Promise<Refinement> {
  const score = scores.get(job.id);
  const ageDays = job.postedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(job.postedAt)) / 86_400_000))
    : null;
  const record = trackRecord === undefined ? trackRecordBlock() : trackRecord;

  const out = await callStructured({
    model: config.env.modelPrefilter,
    system: SYSTEM,
    cachedContext: [
      { label: "Candidate profile", text: JSON.stringify(profile, null, 2) },
      // Cached alongside the profile: identical for every job in a batch.
      ...(record ? [{ label: "Track record so far", text: record }] : []),
    ],
    userPrompt: `Company: ${job.company}
Title: ${job.title}
Outcome bucket for this posting: ${bucketOf(job)}
Location: ${job.location ?? "n/a"} (${job.remote})
Posting age: ${ageDays === null ? "unknown" : `${ageDays} days`}
Fit score: ${score ? `${score.overall}/100 — ${score.summary}` : "n/a"}
Matched keywords: ${score?.matchedKeywords.join(", ") || "n/a"}
Gap keywords: ${score?.gapKeywords.join(", ") || "n/a"}
Description:
${job.description.slice(0, 6000)}`,
    tool: {
      name: "record_hire_odds",
      description: "Record the hire-odds assessment for this posting.",
      schema: RefineOutput,
    },
    maxTokens: 600,
  });

  const refinement: Refinement = {
    jobId: job.id,
    odds: Math.round(out.odds),
    edge: out.edge,
    degreeGated: out.degreeGated,
    competition: out.competition,
    reason: out.reason,
    model: config.env.modelPrefilter,
    refinedAt: new Date().toISOString(),
  };
  refinements.save(refinement);
  events.log({
    jobId: job.id,
    kind: "refined",
    data: { odds: refinement.odds, competition: out.competition, degreeGated: out.degreeGated },
  });
  return refinement;
}

/** Refine every queued job that doesn't have a refinement yet (or was re-scored since). */
export async function refineQueuedJobs(profile: unknown): Promise<{
  refined: number;
  skipped: number;
  errors: number;
}> {
  const queued = [...jobs.byStatus("scored"), ...jobs.byStatus("awaiting_approval")];
  const pending = queued.filter((j) => {
    const r = refinements.get(j.id);
    if (!r) return true;
    const s = scores.get(j.id);
    return !!s && s.scoredAt > r.refinedAt; // re-scored since last refinement
  });

  let refined = 0;
  let errors = 0;
  // One outcome query for the whole batch; every job sees the same evidence.
  const trackRecord = trackRecordBlock();
  const concurrency = Math.max(1, Number(process.env.REFINE_CONCURRENCY ?? 2));
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const job = pending[next++]!;
      try {
        await refineJob(job, profile, trackRecord);
        refined++;
      } catch (err) {
        errors++;
        events.log({ jobId: job.id, kind: "refine_error", data: { error: String(err) } });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { refined, skipped: queued.length - pending.length, errors };
}
