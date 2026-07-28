/**
 * Discovery registry + runner. Iterates enabled sources, runs each adapter,
 * dedupes, and upserts new jobs into the store. Sources needing credentials
 * are skipped unless configured (see config.sourceAllowed).
 *
 * Cross-source dedupe: aggregators re-list jobs we already track from the
 * company's own board. A new job whose (company, title) matches an existing
 * row from a different source — with a compatible location — is stored but
 * immediately parked as `skipped`, so the queue only ever shows one row per
 * real posting. Direct-board rows beat aggregator rows: if the aggregator
 * copy arrived first and hasn't gone past scoring, it's the one parked.
 */
import { config, sourceAllowed } from "../config/index.js";
import { jobs, events } from "../store/repositories.js";
import { crossSourceKey, locationsCompatible, makeJobId } from "../normalize/dedupe.js";
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
import { builtinAdapter } from "./builtin.js";

export interface SourceEntryConfig {
  kind: string;
  enabled: boolean;
  companies: string[];
  queries: string[];
  /** Brand names for boards whose token/slug isn't the display name
   *  (e.g. ashby "posthog" → "PostHog"). Used on letters and the board. */
  displayNames?: Record<string, string>;
  /** Country descriptors to narrow results to, for boards that support it (workday). */
  countries?: string[];
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
  builtin: builtinAdapter,
};

/** Sources that re-list other boards' postings — they lose dupe contests. */
const AGGREGATOR_SOURCES = new Set(["remotive", "weworkremotely", "adzuna", "builtin"]);

/** Early enough in the pipeline that a better-sourced twin can replace it. */
const SUPERSEDABLE_STATUSES = new Set(["discovered", "scored"]);

interface DupeEntry {
  id: string;
  source: string;
  location: string | null;
  status: string;
}

export interface DiscoveryResult {
  discovered: number;
  newJobs: number;
  /** New rows parked as skipped because another source already tracks the posting. */
  duplicates: number;
  bySource: Record<string, number>;
}

export async function runDiscovery(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { discovered: 0, newJobs: 0, duplicates: 0, bySource: {} };

  // (company, title) index over everything already stored, updated as this run
  // inserts — catches dupes both against the DB and across sources in-run.
  const dupeIndex = new Map<string, DupeEntry[]>();
  for (const row of jobs.identities()) {
    const key = crossSourceKey(row);
    (dupeIndex.get(key) ?? dupeIndex.set(key, []).get(key)!).push(row);
  }

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

        if (isNew) {
          const key = crossSourceKey(job);
          const twins = (dupeIndex.get(key) ?? []).filter(
            (t) =>
              t.id !== job.id &&
              t.source !== job.source &&
              locationsCompatible(t.location, job.location),
          );
          // A direct-board row supersedes an aggregator twin that hasn't gone
          // past scoring; anything else (or anything further along) blocks.
          const superseded = twins.filter(
            (t) =>
              !AGGREGATOR_SOURCES.has(job.source) &&
              AGGREGATOR_SOURCES.has(t.source) &&
              SUPERSEDABLE_STATUSES.has(t.status),
          );
          const blocking = twins.filter((t) => !superseded.includes(t));

          if (blocking.length) {
            jobs.upsert(job);
            jobs.setStatus(job.id, "skipped");
            result.duplicates++;
            events.log({
              jobId: job.id,
              kind: "cross_dupe",
              data: { source: job.source, duplicateOf: blocking[0]!.id, ofSource: blocking[0]!.source },
            });
            continue;
          }
          for (const t of superseded) {
            jobs.setStatus(t.id, "skipped");
            t.status = "skipped";
            events.log({
              jobId: t.id,
              kind: "cross_dupe_superseded",
              data: { by: job.id, bySource: job.source },
            });
          }
        }

        jobs.upsert(job);
        if (isNew) {
          result.newJobs++;
          events.log({ jobId: job.id, kind: "discovered", data: { source: job.source } });
          const key = crossSourceKey(job);
          (dupeIndex.get(key) ?? dupeIndex.set(key, []).get(key)!).push({
            id: job.id,
            source: job.source,
            location: job.location,
            status: "discovered",
          });
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
