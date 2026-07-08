/**
 * Stage 1 of scoring: deterministic, free hard filters. Kills obvious non-fits
 * before we spend any tokens. Returns a reason when a job is filtered out, or
 * null when it passes to the LLM stage.
 */
import type { JobPosting } from "../types/index.js";

export interface CandidateProfile {
  preferences: {
    remote: string[];
    locations: string[];
    minSalary: number;
    salaryCurrency: string;
    seniority: string[];
    mustHaveKeywords: string[];
    excludeKeywords: string[];
    excludeCompanies: string[];
  };
  workAuthorization: { authorizedIn: string[]; requiresSponsorship: boolean };
  [k: string]: unknown;
}

export function prefilter(job: JobPosting, profile: CandidateProfile): string | null {
  const p = profile.preferences;
  const hay = `${job.title} ${job.description} ${job.location ?? ""}`.toLowerCase();

  if (p.excludeCompanies.some((c) => job.company.toLowerCase() === c.toLowerCase())) {
    return `excluded company: ${job.company}`;
  }
  for (const kw of p.excludeKeywords) {
    if (hay.includes(kw.toLowerCase())) return `contains excluded keyword: ${kw}`;
  }
  for (const kw of p.mustHaveKeywords) {
    if (!hay.includes(kw.toLowerCase())) return `missing must-have keyword: ${kw}`;
  }

  // Remote preference: only filter when the posting is clearly a mismatch.
  if (job.remote === "onsite" && !p.remote.includes("onsite")) {
    const locationOk = p.locations.some((loc) =>
      (job.location ?? "").toLowerCase().includes(loc.toLowerCase()),
    );
    if (!locationOk) return `onsite role outside preferred locations`;
  }

  // Salary floor: only filter if the posting states a max BELOW the floor and
  // currencies match. Missing comp is NOT a reason to reject (most don't list it).
  if (
    job.compensation?.max != null &&
    job.compensation.currency === p.salaryCurrency &&
    job.compensation.max < p.minSalary
  ) {
    return `max comp ${job.compensation.max} below floor ${p.minSalary}`;
  }

  return null;
}
