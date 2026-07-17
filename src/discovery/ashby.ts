/**
 * Ashby public job board API. JSON, no auth.
 *   https://api.ashbyhq.com/posting-api/job-board/<org>?includeCompensation=true
 * `org` is the board name in jobs.ashbyhq.com/<org>.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  descriptionPlain?: string;
  jobUrl: string;
  applyUrl?: string;
  publishedAt?: string;
  compensation?: { compensationTierSummary?: string };
}

/** Parse a "$120K – $160K" style summary into structured comp when possible. */
function parseComp(summary?: string): JobPosting["compensation"] {
  if (!summary) return null;
  const nums = [...summary.matchAll(/\$?(\d[\d,]*)\s*[kK]?/g)].map((m) =>
    Number(m[1]!.replace(/,/g, "")) * (/[kK]/.test(m[0]) ? 1000 : 1),
  );
  if (nums.length === 0) return null;
  return {
    min: nums[0] ?? null,
    max: nums[1] ?? nums[0] ?? null,
    currency: /CAD/i.test(summary) ? "CAD" : "USD",
    period: "year",
  };
}

export const ashbyAdapter: SourceAdapter = {
  kind: "ashby",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const org of cfg.companies) {
      const res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { jobs: AshbyJob[] };
      const company = cfg.displayNames?.[org] ?? org;
      for (const j of data.jobs ?? []) {
        const description = j.descriptionPlain ?? "";
        const base = { source: "ashby" as const, company, title: j.title, location: j.location ?? null };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: "ashby",
          remote: j.isRemote ? "remote" : classifyRemote(`${j.location ?? ""} ${description}`),
          url: j.jobUrl,
          applyUrl: j.applyUrl ?? j.jobUrl,
          description,
          compensation: parseComp(j.compensation?.compensationTierSummary),
          postedAt: j.publishedAt ?? null,
          discoveredAt: new Date().toISOString(),
          raw: { ashbyId: j.id },
        });
      }
    }
    return out;
  },
};
