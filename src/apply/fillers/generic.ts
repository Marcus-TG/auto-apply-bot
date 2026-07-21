/**
 * Generic fallback filler for unknown ATSes. Walks the visible required inputs,
 * matches each to a known answer via field-map, and pauses for the human on any
 * required field it can't confidently fill. Deliberately conservative: it would
 * rather stop than submit a half-filled form.
 */
import type { Page } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { answerFor } from "../field-map.js";

export interface FillOutcome {
  ready: boolean; // all required fields satisfied → safe to submit
  unresolved: string[]; // labels we couldn't answer (→ needs_human)
}

/** Match an answer against option labels: exact, then whole-word, then
 *  substring only for values long enough not to land inside an unrelated
 *  option ("ON" must never match "ArizONa"). */
export function findOption(options: string[], value: string): string | undefined {
  const v = value.trim().toLowerCase();
  const exact = options.find((o) => o.trim().toLowerCase() === v);
  if (exact) return exact;
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = options.find((o) => new RegExp(`\\b${escaped}\\b`, "i").test(o));
  if (word) return word;
  return v.length >= 4 ? options.find((o) => o.toLowerCase().includes(v)) : undefined;
}

export async function fillGeneric(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  resumeAttached = false,
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  // File upload (resume) — try common selectors. A page with no file input at
  // all is almost certainly not the real form (iframe-embedded ATS, landing
  // page): report it rather than returning a vacuously "clean" fill. Some
  // boards remove the input once a file is attached, so an ATS-specific filler
  // that already attached the resume passes resumeAttached to skip the check.
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    try {
      await fileInput.setInputFiles(resumePath);
    } catch {
      if (!resumeAttached) unresolved.push("resume upload");
    }
  } else if (!resumeAttached) {
    unresolved.push("resume upload (no file input found — is the form on this page?)");
  }

  // Text inputs: use the associated label to decide what to type.
  const inputs = page.locator('input[type="text"], input[type="email"], input[type="tel"], textarea');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const required = (await el.getAttribute("required")) !== null || (await el.getAttribute("aria-required")) === "true";
    const label = await labelFor(page, el);
    if (!label) {
      if (required) unresolved.push("(unlabelled required field)");
      continue;
    }
    // Greenhouse's emailed security/verification code is entered at the submit
    // gate by the post-submit polling loop, not during the fill walk.
    if (/security code|verification code/i.test(label)) continue;
    const value = answerFor(label, fields);
    if (value == null) {
      if (required) unresolved.push(label);
      continue;
    }
    await el.fill(value);
    // React-style comboboxes (Greenhouse custom questions) commit the typed
    // match via keyboard selection; plain inputs ignore the extra keys.
    if ((await el.getAttribute("role")) === "combobox" || (await el.getAttribute("aria-autocomplete"))) {
      await page.waitForTimeout(400);
      // The menu only opens on a keypress, and its first filtered suggestion
      // isn't necessarily the right one ("Man" filters to "Cis-man" first):
      // open with ArrowDown, then click the exact-text option when one is
      // visible, falling back to committing the highlighted suggestion.
      await el.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(300);
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exact = page
        .locator('.select__option:visible, [role="option"]:visible')
        .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
        .first();
      if (await exact.count()) {
        await exact.click().catch(() => {});
      } else {
        await el.press("Enter").catch(() => {});
      }
    }
    await humanPause();
  }

  // Native dropdowns: match the answer against the option labels.
  const selects = page.locator("select");
  const nSel = await selects.count();
  for (let i = 0; i < nSel; i++) {
    const el = selects.nth(i);
    const required = (await el.getAttribute("required")) !== null || (await el.getAttribute("aria-required")) === "true";
    const label = await labelFor(page, el);
    if (!label) {
      if (required) unresolved.push("(unlabelled required select)");
      continue;
    }
    const value = answerFor(label, fields);
    if (value == null) {
      if (required) unresolved.push(label);
      continue;
    }
    const options: string[] = await el.locator("option").allInnerTexts();
    const match = findOption(options, value);
    if (!match) {
      if (required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }
    await el.selectOption({ label: match }).catch(() => {
      if (required) unresolved.push(label);
    });
    await humanPause();
  }

  // Checkboxes (consent/acknowledgement): check only when a rule or approved
  // custom answer explicitly says yes — never auto-consent.
  const checkboxes = page.locator('input[type="checkbox"]');
  const nCb = await checkboxes.count();
  for (let i = 0; i < nCb; i++) {
    const el = checkboxes.nth(i);
    const required = (await el.getAttribute("required")) !== null || (await el.getAttribute("aria-required")) === "true";
    const label = await labelFor(page, el);
    if (!label) continue;
    const value = answerFor(label, fields);
    if (value == null) {
      if (required) unresolved.push(label);
      continue;
    }
    if (/^(yes|true|checked)$/i.test(value)) {
      await el.check().catch(() => {
        if (required) unresolved.push(label);
      });
      await humanPause();
    } else if (required) {
      unresolved.push(label);
    }
  }

  return { ready: unresolved.length === 0, unresolved };
}

async function labelFor(page: Page, el: ReturnType<Page["locator"]>): Promise<string | null> {
  const id = await el.getAttribute("id");
  if (id) {
    const lab = page.locator(`label[for="${id}"]`);
    if (await lab.count()) return (await lab.first().innerText()).trim();
  }
  const aria = await el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const placeholder = await el.getAttribute("placeholder");
  return placeholder?.trim() ?? null;
}

/** Small randomized delay — human-like pacing, not evasion. */
function humanPause(): Promise<void> {
  const ms = 250 + Math.random() * 600;
  return new Promise((r) => setTimeout(r, ms));
}
