/**
 * Adzuna official search API (aggregator). Requires a free API key —
 * register at https://developer.adzuna.com, then set ADZUNA_APP_ID and
 * ADZUNA_APP_KEY. Gated in config.sourceAllowed until both are present.
 *   https://api.adzuna.com/v1/api/jobs/<country>/search/1?app_id=…&app_key=…&what=…
 * Country comes from ADZUNA_COUNTRY (default "ca"). A query of the form
 * "what @ where" splits into keyword + location filter, e.g.
 * "ai automation @ ontario"; without " @ " the whole string is the keyword.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { config } from "../config/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";

interface AdzunaJob {
  id: string;
  title: string;
  description?: string; // plain text, truncated
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  created?: string;
}

const CURRENCY_BY_COUNTRY: Record<string, string> = {
  ca: "CAD",
  us: "USD",
  gb: "GBP",
};

export const adzunaAdapter: SourceAdapter = {
  kind: "adzuna",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const { adzunaAppId, adzunaAppKey, adzunaCountry } = config.env;
    const out: JobPosting[] = [];
    for (const query of cfg.queries) {
      const [what, where] = query.split(" @ ").map((s) => s.trim());
      const params = new URLSearchParams({
        app_id: adzunaAppId,
        app_key: adzunaAppKey,
        what: what ?? query,
        results_per_page: "50",
      });
      if (where) params.set("where", where);
      const res = await fetch(
        `https://api.adzuna.com/v1/api/jobs/${adzunaCountry}/search/1?${params}`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: AdzunaJob[] };
      for (const j of data.results ?? []) {
        const location = j.location?.display_name ?? null;
        const description = j.description ?? "";
        const base = {
          source: "adzuna" as const,
          company: j.company?.display_name ?? "Unknown",
          title: j.title,
          location,
        };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: null, // aggregator — real ATS detected at apply time from the URL
          remote: classifyRemote(`${location ?? ""} ${j.title} ${description}`),
          url: j.redirect_url,
          applyUrl: j.redirect_url,
          description,
          compensation:
            j.salary_min || j.salary_max
              ? {
                  min: j.salary_min ?? null,
                  max: j.salary_max ?? j.salary_min ?? null,
                  currency: CURRENCY_BY_COUNTRY[adzunaCountry] ?? "USD",
                  period: "year",
                }
              : null,
          postedAt: j.created ?? null,
          discoveredAt: new Date().toISOString(),
          raw: { adzunaId: j.id, query },
        });
      }
    }
    return out;
  },
};
