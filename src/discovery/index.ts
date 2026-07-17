/**
 * Discovery registry + runner. Iterates enabled sources, runs each adapter,
 * dedupes, and upserts new jobs into the store. Sources needing credentials
 * are skipped unless configured (see config.sourceAllowed).
 */
import { config, sourceAllowed } from "../config/index.js";
import { jobs, events } from "../store/repositories.js";
import { makeJobId } from "../normalize/dedupe.js";
import type { SourceAdapter } from "./types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { workdayAdapter } from "./workday.js";
import { smartrecruitersAdapter } from "./smartrecruiters.js";
import { workableAdapter } from "./workable.js";
import { remotiveAdapter } from "./remotive.js";
import { weworkremotelyAdapter } from "./weworkremotely.js";
import { adzunaAdapter } from "./adzuna.js";

export interface SourceEntryConfig {
  kind: string;
  enabled: boolean;
  companies: string[];
  queries: string[];
  /** Brand names for boards whose token/slug isn't the display name
   *  (e.g. ashby "posthog" → "PostHog"). Used on letters and the board. */
  displayNames?: Record<string, string>;
  notes?: string;
}

const REGISTRY: Record<string, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
  smartrecruiters: smartrecruitersAdapter,
  workable: workableAdapter,
  remotive: remotiveAdapter,
  weworkremotely: weworkremotelyAdapter,
  adzuna: adzunaAdapter,
};

export interface DiscoveryResult {
  discovered: number;
  newJobs: number;
  bySource: Record<string, number>;
}

export async function runDiscovery(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { discovered: 0, newJobs: 0, bySource: {} };

  for (const src of config.sources) {
    if (!src.enabled) continue;
    if (!sourceAllowed(src.kind)) {
      events.log({ jobId: null, kind: "source_blocked", data: { kind: src.kind } });
      continue;
    }
    const adapter = REGISTRY[src.kind];
    if (!adapter) {
      events.log({ jobId: null, kind: "source_unknown", data: { kind: src.kind } });
      continue;
    }

    try {
      const postings = await adapter.discover(src);
      result.bySource[src.kind] = postings.length;
      result.discovered += postings.length;

      for (const p of postings) {
        // Ensure the id is the canonical dedupe hash regardless of what the adapter set.
        const job = { ...p, id: makeJobId(p) };
        const isNew = !jobs.exists(job.id);
        jobs.upsert(job);
        if (isNew) {
          result.newJobs++;
          events.log({ jobId: job.id, kind: "discovered", data: { source: job.source } });
        }
      }
    } catch (err) {
      events.log({
        jobId: null,
        kind: "source_error",
        data: { kind: src.kind, error: String(err) },
      });
    }
  }
  return result;
}
