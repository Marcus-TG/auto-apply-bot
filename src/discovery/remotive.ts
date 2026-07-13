/**
 * Remotive public API (remote-job aggregator). JSON, no auth.
 *   https://remotive.com/api/remote-jobs?search=<query>&limit=100
 * API terms (see the payload's legal notice): link back to the Remotive URL,
 * credit Remotive as the source, and poll sparingly — they advise max ~4
 * requests per day, and postings are delayed 24h. One request per configured
 * query per run; keep the query list short and discovery runs infrequent.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { makeJobId } from "../normalize/dedupe.js";
import { stripHtml } from "./util.js";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string; // HTML
}

export const remotiveAdapter: SourceAdapter = {
  kind: "remotive",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const query of cfg.queries) {
      const res = await fetch(
        `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=100`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { jobs?: RemotiveJob[] };
      for (const j of data.jobs ?? []) {
        const base = {
          source: "remotive" as const,
          company: j.company_name,
          title: j.title,
          location: j.candidate_required_location ?? null,
        };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: null, // aggregator — real ATS detected at apply time from the URL
          remote: "remote",
          url: j.url,
          applyUrl: j.url,
          description: j.description ? stripHtml(j.description) : "",
          compensation: null,
          postedAt: j.publication_date ?? null,
          discoveredAt: new Date().toISOString(),
          raw: {
            remotiveId: j.id,
            category: j.category,
            tags: j.tags,
            jobType: j.job_type,
            salary: j.salary,
            query,
          },
        });
      }
    }
    return out;
  },
};
