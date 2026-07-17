/**
 * Detect which ATS an apply page uses, so we can pick the right filler. We know
 * the ATS from discovery for API sources, but the apply URL may redirect, so we
 * confirm from the URL/DOM at submit time.
 */
import type { Page } from "playwright";

export type AtsKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "workable"
  | "jazzhr"
  | "unknown";

export function atsFromUrl(url: string): AtsKind {
  if (/greenhouse\.io|boards\.greenhouse/.test(url)) return "greenhouse";
  if (/lever\.co/.test(url)) return "lever";
  if (/ashbyhq\.com/.test(url)) return "ashby";
  if (/myworkdayjobs\.com/.test(url)) return "workday";
  if (/apply\.workable\.com/.test(url)) return "workable";
  if (/applytojob\.com/.test(url)) return "jazzhr";
  return "unknown";
}

export async function detectAts(page: Page): Promise<AtsKind> {
  const url = page.url();
  const byUrl = atsFromUrl(url);
  if (byUrl !== "unknown") return byUrl;
  // Fall back to DOM signatures.
  const html = await page.content();
  if (/greenhouse/i.test(html)) return "greenhouse";
  if (/lever/i.test(html)) return "lever";
  if (/ashby/i.test(html)) return "ashby";
  if (/workable/i.test(html)) return "workable";
  if (/resumator|applytojob/i.test(html)) return "jazzhr";
  return "unknown";
}
