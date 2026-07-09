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

export async function fillGeneric(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  // File upload (resume) — try common selectors.
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    try {
      await fileInput.setInputFiles(resumePath);
    } catch {
      unresolved.push("resume upload");
    }
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
      await el.press("ArrowDown").catch(() => {});
      await el.press("Enter").catch(() => {});
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
    const match = options.find((o) => o.trim().toLowerCase() === value.toLowerCase())
      ?? options.find((o) => o.toLowerCase().includes(value.toLowerCase()));
    if (!match) {
      if (required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }
    await el.selectOption({ label: match }).catch(() => {
      if (required) unresolved.push(label);
    });
    await humanPause();
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
