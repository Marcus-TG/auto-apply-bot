/**
 * Workday public boards. Each tenant exposes an unauthenticated JSON API:
 *   List:   POST https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 *   Detail: GET  https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
 * Configure `companies` as "tenant|wdHost|site" (e.g. "bmo|wd3|External" for
 * bmo.wd3.myworkdayjobs.com/External). Wrong wdHost → 422, wrong site → 404,
 * which is how new tenants are probed.
 *
 * The list response has no description and the scorer needs one, so each NEW
 * posting gets a detail fetch (already-stored jobs are skipped to keep daily
 * runs cheap). When `countries` is set, results are narrowed with the tenant's
 * country facet: the facet parameter NAME varies per tenant ("Country",
 * "CF_-_REC_-_..."), so we find it by matching value descriptors; the country
 * ids themselves are universal Workday reference ids.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";
import { jobs } from "../store/repositories.js";
import { stripHtml, mapLimit } from "./util.js";

interface WdListPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
}

interface WdFacet {
  facetParameter?: string;
  values?: (WdFacet & { descriptor?: string; id?: string })[];
}

interface WdListResponse {
  total?: number;
  jobPostings?: WdListPosting[];
  facets?: WdFacet[];
}

interface WdDetail {
  jobPostingInfo?: {
    jobDescription?: string;
    startDate?: string;
    externalUrl?: string;
  };
}

const MAX_NEW_POSTINGS_PER_COMPANY = 50;
const PAGE_SIZE = 20; // cxs hard limit: limit > 20 → 400
const MAX_LIST_PER_QUERY = 100;

async function searchJobs(
  apiBase: string,
  searchText: string,
  offset: number,
  appliedFacets?: Record<string, string[]>,
): Promise<WdListResponse | null> {
  const res = await fetch(`${apiBase}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      limit: PAGE_SIZE,
      offset,
      searchText,
      ...(appliedFacets ? { appliedFacets } : {}),
    }),
  });
  if (!res.ok) return null;
  return (await res.json()) as WdListResponse;
}

/** Facets can nest (e.g. a location group containing Country) — flatten them. */
function flattenFacets(facets: WdFacet[]): WdFacet[] {
  const out: WdFacet[] = [];
  for (const f of facets) {
    out.push(f);
    const nested = (f.values ?? []).filter((v) => v.facetParameter && v.values);
    if (nested.length) out.push(...flattenFacets(nested));
  }
  return out;
}

/** Build appliedFacets narrowing to the configured countries, if the tenant exposes them. */
function countryFilter(res: WdListResponse, countries: string[]): Record<string, string[]> | null {
  if (!countries.length) return null;
  for (const f of flattenFacets(res.facets ?? [])) {
    const ids = (f.values ?? [])
      .filter((v) => v.descriptor && v.id && countries.includes(v.descriptor))
      .map((v) => v.id!);
    if (ids.length && f.facetParameter) return { [f.facetParameter]: ids };
  }
  return null;
}

export const workdayAdapter: SourceAdapter = {
  kind: "workday",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const entry of cfg.companies) {
      const [tenant, wd, site] = entry.split("|");
      if (!tenant || !wd || !site) continue;
      const apiBase = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
      const siteBase = `https://${tenant}.${wd}.myworkdayjobs.com/${site}`;
      const company = cfg.displayNames?.[tenant] ?? tenant;

      const found = new Map<string, WdListPosting>();
      for (const query of cfg.queries.length ? cfg.queries : [""]) {
        const first = await searchJobs(apiBase, query, 0);
        if (!first) continue;
        const facets = countryFilter(first, cfg.countries ?? []) ?? undefined;
        for (let offset = 0; offset < MAX_LIST_PER_QUERY; offset += PAGE_SIZE) {
          const page =
            offset === 0 && !facets ? first : await searchJobs(apiBase, query, offset, facets);
          if (!page) break;
          const batch = page.jobPostings ?? [];
          for (const p of batch) {
            // Some tenants return stub rows without a title; they'd crash makeJobId.
            if (p.externalPath && p.title && !found.has(p.externalPath)) found.set(p.externalPath, p);
          }
          if (batch.length < PAGE_SIZE) break;
        }
      }

      // The posting's identity fields must match what we return below, so the
      // exists() check and the registry's dedupe hash agree.
      const baseOf = (p: WdListPosting) => ({
        source: "workday" as const,
        company,
        title: p.title,
        location: p.locationsText ?? null,
      });

      const fresh = [...found.values()]
        .filter((p) => !jobs.exists(makeJobId(baseOf(p))))
        .slice(0, MAX_NEW_POSTINGS_PER_COMPANY);

      const postings = await mapLimit(fresh, 5, async (p) => {
        let description = "";
        let postedAt: string | null = null;
        let url = `${siteBase}${p.externalPath}`;
        try {
          const dres = await fetch(`${apiBase}${p.externalPath}`, {
            headers: { accept: "application/json" },
          });
          if (dres.ok) {
            const d = (await dres.json()) as WdDetail;
            description = stripHtml(d.jobPostingInfo?.jobDescription ?? "");
            postedAt = d.jobPostingInfo?.startDate ?? null;
            url = d.jobPostingInfo?.externalUrl ?? url;
          }
        } catch {
          // Detail fetch failure shouldn't drop the posting — keep the list data.
        }

        const base = baseOf(p);
        const posting: JobPosting = {
          id: makeJobId(base),
          ...base,
          ats: "workday",
          remote: classifyRemote(`${p.locationsText ?? ""} ${description.slice(0, 2000)}`),
          url,
          applyUrl: url,
          description,
          compensation: null,
          postedAt,
          discoveredAt: new Date().toISOString(),
          raw: { tenant, wd, site, externalPath: p.externalPath },
        };
        return posting;
      });
      out.push(...postings);
    }
    return out;
  },
};
