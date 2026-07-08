/**
 * Workday public boards. Each tenant exposes a JSON endpoint:
 *   POST https://<host>.<tenant>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 * Because host/tenant/site vary per employer, configure them via `companies`
 * entries of the form "host|tenant|site" (see config/sources.json notes).
 *
 * Left as a working skeleton: the request shape is correct, but Workday tenants
 * differ enough that you'll tune per-employer. Disabled by default.
 */
import type { SourceAdapter } from "./types.js";
import type { SourceEntryConfig } from "./index.js";
import type { JobPosting } from "../types/index.js";
import { classifyRemote, makeJobId } from "../normalize/dedupe.js";

export const workdayAdapter: SourceAdapter = {
  kind: "workday",
  async discover(cfg: SourceEntryConfig): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const entry of cfg.companies) {
      const [host, tenant, site] = entry.split("|");
      if (!host || !tenant || !site) continue;
      const url = `https://${host}.${tenant}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 50, offset: 0, searchText: cfg.queries.join(" ") }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        jobPostings?: { title: string; externalPath: string; locationsText?: string }[];
      };
      for (const j of data.jobPostings ?? []) {
        const jobUrl = `https://${host}.${tenant}.myworkdayjobs.com/${site}${j.externalPath}`;
        const base = { source: "workday" as const, company: tenant, title: j.title, location: j.locationsText ?? null };
        out.push({
          id: makeJobId(base),
          ...base,
          ats: "workday",
          remote: classifyRemote(j.locationsText ?? ""),
          url: jobUrl,
          applyUrl: jobUrl,
          description: "", // Workday detail requires a second fetch per posting; add if needed.
          compensation: null,
          postedAt: null,
          discoveredAt: new Date().toISOString(),
          raw: { host, tenant, site, externalPath: j.externalPath },
        });
      }
    }
    return out;
  },
};
