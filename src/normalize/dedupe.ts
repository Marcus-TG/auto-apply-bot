/**
 * Dedupe key generation + light normalization helpers.
 *
 * The same role often appears on multiple boards. We key jobs on a stable hash of
 * (source, company, title, location) so re-discovering a posting updates rather
 * than duplicates it. Cross-source dupes (same job on Greenhouse AND LinkedIn) are
 * handled separately by `crossSourceKey` for reporting; we still track both rows
 * because their apply flows differ.
 */
import { createHash } from "node:crypto";
import type { JobPosting } from "../types/index.js";

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

/** Canonical per-source id. */
export function makeJobId(p: Pick<JobPosting, "source" | "company" | "title" | "location">): string {
  const basis = [p.source, normalizeText(p.company), normalizeText(p.title), normalizeText(p.location ?? "")].join("|");
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/** Source-independent key to detect the same job across boards. */
export function crossSourceKey(p: Pick<JobPosting, "company" | "title">): string {
  return createHash("sha1")
    .update([normalizeText(p.company), normalizeText(p.title)].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/** Best-effort remote classification from free text. */
export function classifyRemote(text: string): JobPosting["remote"] {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|distributed)\b/.test(t)) return "remote";
  if (/\b(on-?site|in office|in-person)\b/.test(t)) return "onsite";
  return "unknown";
}
