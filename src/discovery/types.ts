/**
 * The contract every job source implements. Add a new board by writing one file
 * that exports a `SourceAdapter` and registering it in index.ts — nothing else
 * in the pipeline changes.
 */
import type { JobPosting } from "../types/index.js";
import type { SourceEntryConfig } from "./index.js";

export interface SourceAdapter {
  kind: string;
  /**
   * Pull current postings for the configured companies/queries and return them
   * NORMALIZED. Adapters should be resilient: a single bad posting should be
   * skipped and logged, not throw the whole run.
   */
  discover(cfg: SourceEntryConfig): Promise<JobPosting[]>;
}
