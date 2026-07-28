/**
 * Dedupe key generation + light normalization helpers.
 *
 * The same role often appears on multiple boards. We key jobs on a stable hash of
 * (source, company, title, location) so re-discovering a posting updates rather
 * than duplicates it. Cross-source dupes (same job on Greenhouse AND an
 * aggregator) are caught at discovery time via `crossSourceKey` +
 * `locationsCompatible`: the duplicate row is stored but parked as `skipped`
 * so it never reaches the queue (see discovery/index.ts).
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

/**
 * Whether two location strings could refer to the same posting. crossSourceKey
 * ignores location (formats differ per board: "Toronto, ON" vs "Toronto,
 * Ontario, Canada"), so this guards against collapsing a genuinely multi-city
 * req. Compare the leading city segment; unknown/remote locations match
 * anything.
 */
export function locationsCompatible(a: string | null, b: string | null): boolean {
  const city = (s: string) => normalizeText(s.split(/[,•|(]/)[0] ?? "");
  const ca = city(a ?? "");
  const cb = city(b ?? "");
  if (!ca || !cb) return true;
  if (/\bremote\b/.test(ca) || /\bremote\b/.test(cb)) return true;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

/** Best-effort remote classification from free text. */
export function classifyRemote(text: string): JobPosting["remote"] {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|distributed)\b/.test(t)) return "remote";
  if (/\b(on-?site|in office|in-person)\b/.test(t)) return "onsite";
  return "unknown";
}
