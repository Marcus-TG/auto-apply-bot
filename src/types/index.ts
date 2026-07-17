/**
 * Core domain types for the pipeline.
 *
 * These are the contracts every module agrees on. Adapters produce `JobPosting`,
 * the scorer produces `FitScore`, the tailor produces `TailoredApplication`, and
 * the store persists everything with an audit trail.
 *
 * Zod schemas double as (a) runtime validation of untrusted input (scraped HTML,
 * LLM JSON output) and (b) the single source of truth for the TypeScript types.
 */
import { z } from "zod";

/** Where a posting came from. */
export const SourceKind = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "workable",
  "remotive", // aggregator, public API (link back to their URL; poll sparingly)
  "weworkremotely", // aggregator, public RSS
  "adzuna", // aggregator, official API — gated behind ADZUNA_APP_ID/KEY
  "manual",
]);
export type SourceKind = z.infer<typeof SourceKind>;

/** Lifecycle of a job as it moves through the pipeline. */
export const JobStatus = z.enum([
  "discovered", // normalized & stored, not yet scored
  "prefiltered_out", // failed a deterministic hard filter — cheap reject
  "scored", // has an LLM fit score
  "rejected", // below the apply floor
  "tailoring", // generating resume + cover letter
  "awaiting_approval", // sitting in the human review queue
  "approved", // human said go (or auto-approved by lane rules)
  "submitting", // browser flow in progress (locked, idempotent)
  "submitted", // application confirmed sent
  "needs_human", // paused: captcha, unknown required field, login wall, etc.
  "failed", // unrecoverable error — see events log
  "skipped", // expired/closed/duplicate
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Compensation = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().default("USD"),
  period: z.enum(["year", "hour", "unknown"]).default("unknown"),
});

/** The normalized shape every discovery adapter must emit. */
export const JobPosting = z.object({
  /** Stable dedupe key: hash of (source, company, title, location) — see normalize/dedupe.ts */
  id: z.string(),
  source: SourceKind,
  /** The ATS/host detected for this posting (drives which filler is used at submit time). */
  ats: z.string().nullable(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  remote: z.enum(["remote", "hybrid", "onsite", "unknown"]).default("unknown"),
  url: z.string().url(),
  /** Canonical apply URL if different from the posting URL. */
  applyUrl: z.string().url().nullable(),
  description: z.string(),
  compensation: Compensation.nullable(),
  postedAt: z.string().nullable(), // ISO8601 if the source provides it
  discoveredAt: z.string(), // ISO8601
  /** Anything source-specific we may want later (raw ids, tags, department). */
  raw: z.record(z.unknown()).default({}),
});
export type JobPosting = z.infer<typeof JobPosting>;

/** A single rubric dimension the LLM scores. Weights live in config/thresholds.json. */
export const ScoreDimension = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  rationale: z.string(),
});

/** Output of the fit-scoring stage. */
export const FitScore = z.object({
  jobId: z.string(),
  /** 0-100 weighted overall. */
  overall: z.number().min(0).max(100),
  /** How sure the model is about its own assessment (drives the review lane). */
  confidence: z.number().min(0).max(1),
  dimensions: z.array(ScoreDimension),
  /** Which resume variant the model thinks fits best (by variant id). */
  recommendedVariant: z.string(),
  /** Short human-readable "why this is / isn't a fit". Shown on the approval card. */
  summary: z.string(),
  /** Keywords from the JD the candidate genuinely supports (used by the tailor). */
  matchedKeywords: z.array(z.string()),
  /** Keywords in the JD we do NOT have evidence for (honesty guardrail — never fabricate these). */
  gapKeywords: z.array(z.string()),
  model: z.string(),
  scoredAt: z.string(),
});
export type FitScore = z.infer<typeof FitScore>;

/** The generated, ready-to-submit materials for one job. */
export const TailoredApplication = z.object({
  jobId: z.string(),
  variantId: z.string(),
  resumePath: z.string(), // rendered PDF in ARTIFACTS_DIR
  resumeJsonPath: z.string(), // structured resume that produced the PDF (for audit/edits)
  coverLetterPath: z.string(),
  coverLetterText: z.string(),
  createdAt: z.string(),
});
export type TailoredApplication = z.infer<typeof TailoredApplication>;

/** Which lane a scored job falls into. See docs/APPROVAL-FLOW.md. */
export const ApprovalLane = z.enum([
  "reject", // below floor: never apply
  "auto", // mid-band: apply without asking (only if enabled in config)
  "review", // high-fit: always ask the human first
]);
export type ApprovalLane = z.infer<typeof ApprovalLane>;

export const ApprovalDecision = z.enum(["approve", "reject", "edit", "timeout"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** Append-only audit record. Every meaningful action writes one of these. */
export const PipelineEvent = z.object({
  jobId: z.string().nullable(),
  kind: z.string(), // e.g. "scored", "approval_requested", "submit_failed"
  at: z.string(),
  data: z.record(z.unknown()).default({}),
});
export type PipelineEvent = z.infer<typeof PipelineEvent>;

/** Result of a submission attempt from the apply layer. */
export type SubmitResult =
  | { status: "submitted"; confirmation: string | null }
  | { status: "needs_human"; reason: string; liveViewUrl: string | null }
  | { status: "failed"; error: string };
