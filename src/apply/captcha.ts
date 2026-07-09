/**
 * CAPTCHA / anti-bot handling policy: DETECT and HAND OFF to a human. We do not
 * try to solve CAPTCHAs — it's the honest choice and the reliable one. When we
 * detect a challenge, we return the live-view URL so the human can complete it,
 * and the pipeline parks the job in `needs_human`.
 */
import type { Page } from "playwright";

// Text that only appears on blocking interstitials, never on normal pages.
const BLOCKING_SIGNATURES = [
  "just a moment",
  "checking your browser",
  "verify you are human",
  "are you a human",
  "px-captcha",
];

/**
 * True only for challenges that actually BLOCK the flow: interstitial pages
 * ("Just a moment…") or a visible interactive widget (hCaptcha / reCAPTCHA
 * checkbox, Turnstile). The passive reCAPTCHA v3 badge that Greenhouse loads
 * on every form is NOT a challenge — the form is fillable and the site mints
 * its own token at submit time.
 */
export async function detectChallenge(page: Page): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  if (BLOCKING_SIGNATURES.some((s) => title.includes(s))) return true;

  const bodyText = ((await page.locator("body").innerText().catch(() => "")) ?? "").toLowerCase();
  if (BLOCKING_SIGNATURES.some((s) => bodyText.includes(s))) return true;

  // Visible interactive captcha widgets, excluding the passive v3 badge.
  const interactive = await page
    .locator('iframe[src*="captcha" i], .cf-turnstile, .h-captcha')
    .evaluateAll((els) =>
      els.filter((el) => {
        if (el.closest(".grecaptcha-badge")) return false; // passive badge
        const rect = el.getBoundingClientRect();
        return rect.width > 50 && rect.height > 50; // badge iframes are tiny/offscreen
      }).length,
    )
    .catch(() => 0);
  return interactive > 0;
}
