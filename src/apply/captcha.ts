/**
 * CAPTCHA / anti-bot handling policy: DETECT and HAND OFF to a human. We do not
 * try to solve CAPTCHAs — it's the honest choice and the reliable one. When we
 * detect a challenge, we return the live-view URL so the human can complete it,
 * and the pipeline parks the job in `needs_human`.
 */
import type { Page } from "playwright";

const CAPTCHA_SIGNATURES = [
  "recaptcha",
  "hcaptcha",
  "cf-challenge",
  "g-recaptcha",
  "px-captcha",
  "are you a human",
  "verify you are human",
];

export async function detectChallenge(page: Page): Promise<boolean> {
  const html = (await page.content()).toLowerCase();
  if (CAPTCHA_SIGNATURES.some((s) => html.includes(s))) return true;
  // iframe-based challenges
  const frames = page.frames().map((f) => f.url().toLowerCase());
  return frames.some((u) => /recaptcha|hcaptcha|captcha/.test(u));
}
