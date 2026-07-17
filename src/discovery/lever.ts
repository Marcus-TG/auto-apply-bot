/**
 * Lever public postings API. JSON, no auth.
 *   https://api.lever.co/v0/postings/<handle>?mode=json
 * `handle` is the company slug in jobs.lever.co/<handle>.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";

interface LeverPosting {
  id: string;
  text: string; // title
  hostedUrl: string;
  applyUrl?: string;
  categories?: { location?: string; commitment?: string; team?: string };
  descriptionPlain?: string;
  createdAt?: number;
}

export const leverAdapter: SourceAdapter = {
  kind: "lever",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const handle of cfg.companies) {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`,
      );
      if (!res.ok) continue;
      const list = (await res.json()) as LeverPosting[];
      for (const p of list) {
        const location = p.categories?.location ?? null;
        const description = p.descriptionPlain ?? "";
        const base = { source: "lever" as const, company: handle, title: p.text, location };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: "lever",
          remote: classifyRemote(`${location ?? ""} ${description}`),
          url: p.hostedUrl,
          applyUrl: p.applyUrl ?? p.hostedUrl,
          description,
          compensation: null,
          postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          discoveredAt: new Date().toISOString(),
          raw: { leverId: p.id, team: p.categories?.team },
        });
      }
    }
    return out;
  },
};
