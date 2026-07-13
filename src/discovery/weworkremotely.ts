/**
 * We Work Remotely public RSS feeds (remote-job aggregator). No auth.
 *   https://weworkremotely.com/categories/<category-slug>.rss
 * Configure category slugs in `queries`, e.g. "remote-devops-sysadmin-jobs",
 * "remote-programming-jobs", "remote-customer-support-jobs".
 * Item titles are "Company: Job Title"; <region> carries the location scope.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { makeJobId } from "../normalize/dedupe.js";
import { stripHtml } from "./util.js";

/** Pull the inner text of the first <tag>…</tag> in an RSS item block. */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1]!.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export const weworkremotelyAdapter: SourceAdapter = {
  kind: "weworkremotely",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const category of cfg.queries) {
      const res = await fetch(
        `https://weworkremotely.com/categories/${encodeURIComponent(category)}.rss`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const item = m[1]!;
        const rawTitle = decodeEntities(tag(item, "title"));
        // "Company: Job Title" — company names may not contain ":", titles may.
        const sep = rawTitle.indexOf(": ");
        if (sep < 0) continue;
        const company = rawTitle.slice(0, sep).trim();
        const title = rawTitle.slice(sep + 2).trim();
        const region = decodeEntities(tag(item, "region")) || null;
        const url = tag(item, "link");
        if (!url) continue;

        const pubDate = new Date(tag(item, "pubDate"));
        const base = { source: "weworkremotely" as const, company, title, location: region };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: null, // aggregator — real ATS detected at apply time from the URL
          remote: "remote",
          url,
          applyUrl: url,
          description: stripHtml(decodeEntities(tag(item, "description"))),
          compensation: null,
          postedAt: isNaN(pubDate.getTime()) ? null : pubDate.toISOString(),
          discoveredAt: new Date().toISOString(),
          raw: { category, wwrCategory: decodeEntities(tag(item, "category")) },
        });
      }
    }
    return out;
  },
};
