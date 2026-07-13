/**
 * Greenhouse public boards API. ToS-friendly JSON, no auth.
 *   Jobs:   https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
 * `token` is the board slug in boards.greenhouse.io/<token>.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote } from "../normalize/dedupe.js";
import { makeJobId } from "../normalize/dedupe.js";
import { stripHtml } from "./util.js";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  location?: { name?: string };
  content?: string; // HTML-encoded when content=true
  company_name?: string;
}

export const greenhouseAdapter: SourceAdapter = {
  kind: "greenhouse",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const token of cfg.companies) {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { jobs: GhJob[] };
      for (const j of data.jobs ?? []) {
        const location = j.location?.name ?? null;
        const description = j.content ? stripHtml(j.content) : "";
        const base = {
          source: "greenhouse" as const,
          company: j.company_name ?? token,
          title: j.title,
          location,
        };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: "greenhouse",
          remote: classifyRemote(`${location ?? ""} ${description}`),
          url: j.absolute_url,
          applyUrl: j.absolute_url,
          description,
          compensation: null,
          postedAt: j.updated_at ?? null,
          discoveredAt: new Date().toISOString(),
          raw: { greenhouseId: j.id, boardToken: token },
        });
      }
    }
    return out;
  },
};
