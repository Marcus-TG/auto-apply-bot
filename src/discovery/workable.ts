/**
 * Workable public widget API. JSON, no auth.
 *   List:   https://apply.workable.com/api/v1/widget/accounts/<account>
 *   Detail: https://apply.workable.com/api/v2/accounts/<account>/jobs/<shortcode>
 * `account` is the slug in apply.workable.com/<account>/.
 * The widget list has no description, so we fetch each job's v2 detail
 * (description + requirements + benefits) with bounded concurrency.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";
import { stripHtml, mapLimit } from "./util.js";

interface WkJob {
  title: string;
  shortcode: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  country?: string;
  city?: string;
  state?: string;
}

interface WkDetail {
  description?: string;
  requirements?: string;
  benefits?: string;
  workplace?: string; // "remote" | "hybrid" | "on_site"
}

export const workableAdapter: SourceAdapter = {
  kind: "workable",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const account of cfg.companies) {
      const res = await fetch(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { name?: string; jobs?: WkJob[] };
      const company = data.name ?? account;

      const postings = await mapLimit(data.jobs ?? [], 5, async (j) => {
        const location = [j.city, j.state, j.country].filter(Boolean).join(", ") || null;

        let description = "";
        let workplace: string | undefined;
        try {
          const dres = await fetch(
            `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${j.shortcode}`,
            { headers: { "User-Agent": "Mozilla/5.0" } },
          );
          if (dres.ok) {
            const d = (await dres.json()) as WkDetail;
            description = stripHtml(
              [d.description, d.requirements, d.benefits].filter(Boolean).join(" "),
            );
            workplace = d.workplace;
          }
        } catch {
          // Detail fetch failure shouldn't drop the posting — keep the list data.
        }

        const base = { source: "workable" as const, company, title: j.title, location };
        const url = j.url ?? `https://apply.workable.com/j/${j.shortcode}`;
        const posting: JobPosting = {
          id: makeJobId(base),
          ...base,
          ats: "workable",
          remote:
            workplace === "remote" || j.telecommuting
              ? "remote"
              : workplace === "hybrid"
                ? "hybrid"
                : workplace === "on_site"
                  ? "onsite"
                  : classifyRemote(`${location ?? ""} ${description}`),
          url,
          applyUrl: j.application_url ?? `${url}/apply`,
          description,
          compensation: null,
          postedAt: j.published_on ?? null,
          discoveredAt: new Date().toISOString(),
          raw: { workableShortcode: j.shortcode, account, department: j.department },
        };
        return posting;
      });
      out.push(...postings);
    }
    return out;
  },
};
