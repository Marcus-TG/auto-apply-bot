/**
 * Career lanes: named slices of the market with their own apply floor.
 *
 * The fit scorer answers "does this candidate's experience match the posting's
 * stated requirements". That question is structurally unfair to a PIVOT: an
 * entry-level IT support role scores ~50-64 for "lacks direct IT support
 * experience", which is the whole point of pivoting into it, while senior AI
 * roles score 70-83 on keyword overlap with the existing background and then
 * get rejected by the market in 48 hours. A single flat applyFloor therefore
 * rejects the lane the candidate is actually trying to enter.
 *
 * A lane re-floors that slice instead of re-writing the scorer: matching jobs
 * keep their honest fit score and simply get judged against a floor that suits
 * an entry-level target. Lanes are config-driven (config/thresholds.json) so
 * the market slice can change without a code edit.
 */
import { config } from "../config/index.js";

export interface Lane {
  id: string;
  label: string;
  applyFloor: number;
  titlePattern: string;
  excludeTitlePattern?: string;
  locationPattern?: string;
  note?: string;
}

/** Compiled once per lane — these run over every scored job. */
const cache = new Map<string, RegExp>();
function rx(pattern: string): RegExp {
  let r = cache.get(pattern);
  if (!r) {
    r = new RegExp(pattern, "i");
    cache.set(pattern, r);
  }
  return r;
}

/** Only title and location decide a lane, so callers needn't carry a full posting. */
export type LaneCandidate = { title: string; location: string | null };

function matches(lane: Lane, job: LaneCandidate): boolean {
  if (!rx(lane.titlePattern).test(job.title)) return false;
  if (lane.excludeTitlePattern && rx(lane.excludeTitlePattern).test(job.title)) return false;
  if (lane.locationPattern) {
    // Location text is the authority. A bare "remote" is NOT a match: worldwide
    // remote postings are a different (and far more crowded) market than the
    // local one this lane exists to surface.
    if (!rx(lane.locationPattern).test(job.location ?? "")) return false;
  }
  return true;
}

/** The first configured lane this job belongs to, or null for the general market. */
export function laneFor(job: LaneCandidate): Lane | null {
  for (const lane of config.thresholds.lanes ?? []) {
    if (matches(lane, job)) return lane;
  }
  return null;
}

/** The apply floor that applies to this job: its lane's, else the global one. */
export function floorFor(job: LaneCandidate): number {
  return laneFor(job)?.applyFloor ?? config.thresholds.applyFloor;
}
