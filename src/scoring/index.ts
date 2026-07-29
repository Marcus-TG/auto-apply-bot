/**
 * Scoring orchestration: prefilter → LLM score → assign an approval lane.
 * Lane rules live here so the pipeline and the docs agree on one source of truth.
 */
import { config } from "../config/index.js";
import type { FitScore, ApprovalLane, JobPosting } from "../types/index.js";
import type { CandidateProfile } from "./prefilter.js";
import { prefilter } from "./prefilter.js";
import { floorFor } from "./lanes.js";
import { scoreWithLlm, type VariantSummary } from "./llm-scorer.js";

export { prefilter } from "./prefilter.js";
export type { CandidateProfile } from "./prefilter.js";

/**
 * Map a score to a lane. See docs/APPROVAL-FLOW.md.
 *   overall < applyFloor                          → reject
 *   overall >= reviewFloor                        → review (high-fit: always ask)
 *   otherwise (mid-band)                          → auto IF enabled AND confident, else review
 */
export function assignLane(score: FitScore, job?: Pick<JobPosting, "title" | "location" | "remote">): ApprovalLane {
  const t = config.thresholds;
  // Career lanes re-floor their slice of the market; without a job we can't tell
  // which lane applies, so fall back to the global floor.
  const floor = job ? floorFor(job) : t.applyFloor;
  if (score.overall < floor) return "reject";
  if (score.overall >= t.reviewFloor) return "review";
  if (t.autoApplyEnabled && score.confidence >= t.minConfidenceForAuto) return "auto";
  return "review";
}

export interface ScoreOutcome {
  filtered?: string; // prefilter reason if rejected cheaply
  score?: FitScore;
  lane?: ApprovalLane;
}

export async function scoreJob(
  job: JobPosting,
  profile: CandidateProfile,
  variants: VariantSummary[],
): Promise<ScoreOutcome> {
  const reason = prefilter(job, profile);
  if (reason) return { filtered: reason };

  const score = await scoreWithLlm(job, profile, variants, config.env.modelPrefilter);
  const lane = assignLane(score, job);
  return { score, lane };
}
