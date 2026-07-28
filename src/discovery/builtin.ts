/**
 * Built In (builtin.com) — tech-job aggregator, no official API. Search pages
 * are server-rendered (plain fetch, no bot wall) and embed a schema.org
 * ItemList of results; each job page embeds a JobPosting JSON-LD node plus a
 * `Builtin.jobPostInit({...})` bootstrap whose `howToApply` is the DIRECT
 * external ATS apply URL (so unlike other aggregators we can set `ats` at
 * discovery time). `isEasyApply` postings apply through a Built In account —
 * those keep applyUrl null and are flagged in raw.
 *
 * Configure `queries` as search terms and `countries` as ISO3 codes for the
 * `country=` filter (e.g. "CAN"). robots.txt allows `/jobs*?page=` pagination;
 * page caps stay low to be polite. Only unseen job URLs get a detail fetch.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";
import { jobs } from "../store/repositories.js";
import { stripHtml, mapLimit } from "./util.js";
import { atsFromUrl } from "../apply/ats-detect.js";

const MAX_PAGES_PER_QUERY = 3; // 25 results/page
const MAX_NEW_POSTINGS = 50;
const HEADERS = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" };

interface LdNode {
  "@type"?: string;
  "@graph"?: LdNode[];
  itemListElement?: { name?: string; url?: string; description?: string }[];
  title?: string;
  description?: string;
  datePosted?: string;
  jobLocationType?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: LdPlace | LdPlace[];
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  } | null;
}

interface LdPlace {
  address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string };
}

/** All JSON-LD nodes on the page, with @graph containers flattened. The "+" in
 *  application/ld+json is HTML-entity-encoded on Built In pages. */
function ldNodes(html: string): LdNode[] {
  const out: LdNode[] = [];
  for (const m of html.matchAll(
    /<script type="application\/ld(?:\+|&#x2B;)json">\s*([\s\S]*?)<\/script>/g,
  )) {
    try {
      const parsed = JSON.parse(m[1]!) as LdNode;
      out.push(...(parsed["@graph"] ?? [parsed]));
    } catch {
      // malformed block — ignore, other nodes may still parse
    }
  }
  return out;
}

/** A JSON-escaped string field from the jobPostInit bootstrap (howToApply URLs
 *  carry &-style escapes, so run it back through JSON.parse). */
function initField(html: string, field: string): string | null {
  const m = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`).exec(html);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]!}"`) as string;
  } catch {
    return null;
  }
}

function locationOf(node: LdNode): string | null {
  const place = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
  const addr = place?.address;
  if (!addr) return null;
  const parts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
  return parts.length ? parts.join(", ") : addr.addressCountry ?? null;
}

function compensationOf(node: LdNode): JobPosting["compensation"] {
  const v = node.baseSalary?.value;
  if (!v || (v.minValue == null && v.maxValue == null)) return null;
  const unit = (v.unitText ?? "").toUpperCase();
  return {
    min: v.minValue ?? null,
    max: v.maxValue ?? null,
    currency: node.baseSalary?.currency ?? "USD",
    period: unit === "YEAR" ? "year" : unit === "HOUR" ? "hour" : "unknown",
  };
}

function remoteOf(node: LdNode, html: string, description: string): JobPosting["remote"] {
  if (node.jobLocationType === "TELECOMMUTE") return "remote";
  // The job header renders a workplace badge before any related-job cards, so
  // the first badge on the page belongs to this posting.
  const badge = />(Remote|Hybrid|In-Office)</.exec(html)?.[1];
  if (badge === "Remote") return "remote";
  if (badge === "Hybrid") return "hybrid";
  if (badge === "In-Office") return "onsite";
  return classifyRemote(description.slice(0, 2000));
}

export const builtinAdapter: SourceAdapter = {
  kind: "builtin",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    // url → search-result summary (kept as a description fallback)
    const found = new Map<string, { summary: string; query: string }>();

    for (const query of cfg.queries) {
      for (const country of cfg.countries?.length ? cfg.countries : [""]) {
        for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
          const u = new URL("https://builtin.com/jobs");
          u.searchParams.set("search", query);
          if (country) u.searchParams.set("country", country);
          if (page > 1) u.searchParams.set("page", String(page));

          const res = await fetch(u, { headers: HEADERS });
          if (!res.ok) break;
          const list = ldNodes(await res.text()).find((n) => n["@type"] === "ItemList");
          const items = (list?.itemListElement ?? []).filter((i) => i.url?.includes("/job/"));
          if (!items.length) break;
          for (const item of items) {
            if (!found.has(item.url!)) {
              found.set(item.url!, { summary: item.description ?? "", query });
            }
          }
          if ((list?.itemListElement ?? []).length < 25) break; // last page
        }
      }
    }

    const known = new Set(jobs.urlsBySource("builtin"));
    const fresh = [...found.entries()]
      .filter(([url]) => !known.has(url))
      .slice(0, MAX_NEW_POSTINGS);

    const postings = await mapLimit(fresh, 4, async ([url, meta]) => {
      let html: string;
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        html = await res.text();
      } catch {
        return null;
      }

      const ld = ldNodes(html).find((n) => n["@type"] === "JobPosting");
      const company = ld?.hiringOrganization?.name ?? initField(html, "companyName");
      const title = ld?.title ?? initField(html, "title");
      if (!company || !title) return null; // can't build an identity — skip

      const howToApply = initField(html, "howToApply");
      const easyApply = /"isEasyApply":true/.test(html);
      const applyUrl = !easyApply && howToApply?.startsWith("http") ? howToApply : null;
      const ats = applyUrl ? atsFromUrl(applyUrl) : "unknown";
      const description = stripHtml(ld?.description ?? "") || meta.summary;

      const base = {
        source: "builtin" as const,
        company,
        title,
        location: ld ? locationOf(ld) : null,
      };
      const posting: JobPosting = {
        id: makeJobId(base),
        ...base,
        ats: ats === "unknown" ? null : ats,
        remote: remoteOf(ld ?? {}, html, description),
        url,
        applyUrl,
        description,
        compensation: ld ? compensationOf(ld) : null,
        postedAt: ld?.datePosted ? new Date(ld.datePosted).toISOString() : null,
        discoveredAt: new Date().toISOString(),
        raw: {
          builtinId: /\/job\/[^/]+\/(\d+)/.exec(url)?.[1] ?? null,
          query: meta.query,
          easyApply,
          howToApply,
        },
      };
      return posting;
    });

    return postings.filter((p): p is JobPosting => p !== null);
  },
};
