/**
 * SmartRecruiters public postings API. JSON, no auth.
 *   List:   https://api.smartrecruiters.com/v1/companies/<id>/postings?limit=100
 *   Detail: https://api.smartrecruiters.com/v1/companies/<id>/postings/<postingId>
 * `id` is the company identifier in jobs.smartrecruiters.com/<id>/... URLs.
 * The list has no description or apply URL, so we fetch each posting's detail
 * (bounded concurrency, capped at 100 postings per company per run).
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";
import { stripHtml, mapLimit } from "./util.js";

interface SrListItem {
  id: string;
  name: string;
  releasedDate?: string;
  company?: { name?: string; identifier?: string };
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    hybrid?: boolean;
    fullLocation?: string;
  };
}

interface SrDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

const MAX_POSTINGS_PER_COMPANY = 100;

export const smartrecruitersAdapter: SourceAdapter = {
  kind: "smartrecruiters",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const id of cfg.companies) {
      const res = await fetch(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings?limit=${MAX_POSTINGS_PER_COMPANY}`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { content?: SrListItem[] };
      const items = data.content ?? [];

      const postings = await mapLimit(items, 5, async (j) => {
        const loc = j.location ?? {};
        const location = loc.fullLocation ?? [loc.city, loc.region, loc.country].filter(Boolean).join(", ") ?? null;

        let description = "";
        let url = `https://jobs.smartrecruiters.com/${encodeURIComponent(id)}/${j.id}`;
        let applyUrl: string | null = url;
        try {
          const dres = await fetch(
            `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings/${j.id}`,
          );
          if (dres.ok) {
            const d = (await dres.json()) as SrDetail;
            description = stripHtml(
              Object.values(d.jobAd?.sections ?? {})
                .map((s) => s.text ?? "")
                .join(" "),
            );
            url = d.postingUrl ?? url;
            applyUrl = d.applyUrl ?? url;
          }
        } catch {
          // Detail fetch failure shouldn't drop the posting — keep the list data.
        }

        const base = {
          source: "smartrecruiters" as const,
          company: j.company?.name ?? id,
          title: j.name,
          location: location || null,
        };
        const posting: JobPosting = {
          id: makeJobId(base),
          ...base,
          ats: "smartrecruiters",
          remote: loc.remote
            ? "remote"
            : loc.hybrid
              ? "hybrid"
              : classifyRemote(`${location ?? ""} ${description}`),
          url,
          applyUrl,
          description,
          compensation: null,
          postedAt: j.releasedDate ?? null,
          discoveredAt: new Date().toISOString(),
          raw: { smartrecruitersId: j.id, companyIdentifier: id },
        };
        return posting;
      });
      out.push(...postings);
    }
    return out;
  },
};
