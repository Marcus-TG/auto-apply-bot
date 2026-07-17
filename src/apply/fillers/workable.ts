/**
 * Workable-hosted application form (apply.workable.com). Stable hooks:
 *   - Identity fields carry `data-ui` attributes (firstname, lastname, email,
 *     resume); the phone number is a bare `input[name="phone"]`.
 *   - Company questions are keyed `QA_*` (custom) / `CA_*` (address block):
 *     text inputs carry the key as their own data-ui, radio groups are a
 *     `fieldset[data-ui]` with a legend, choose-one checkbox groups are a
 *     `[role="group"][data-ui]`.
 *   - Combobox text inputs are named `input_<key>_input`; commit the typed
 *     value with ArrowDown+Enter like the Greenhouse ones.
 */
import type { Page, Locator } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { answerFor } from "../field-map.js";
import type { FillOutcome } from "./generic.js";

export const WORKABLE_SUBMIT = 'button[data-ui="apply-button"], button[type="submit"]';

export async function fillWorkable(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  await dismissCookieBanner(page);

  const fillByUi = async (ui: string, value: string) => {
    const el = page.locator(`input[data-ui="${ui}"], textarea[data-ui="${ui}"]`).first();
    if (await el.count()) {
      await el.fill(value).catch(() => unresolved.push(ui));
      await humanPause();
    }
  };
  await fillByUi("firstname", fields.firstName);
  await fillByUi("lastname", fields.lastName);
  await fillByUi("email", fields.email);

  // Phone sits next to a country-code combobox that defaults from geo; give it
  // the national number so the two don't double the +1.
  const phone = page.locator('input[name="phone"], input[type="tel"]').first();
  if (await phone.count()) {
    await phone.fill(fields.phone.replace(/^\+?1[-.\s]?/, "")).catch(() => {});
    await humanPause();
  }

  const resume = page.locator('input[type="file"][data-ui="resume"], [data-ui="resume"] input[type="file"]').first();
  if (await resume.count()) {
    await resume.setInputFiles(resumePath).catch(() => unresolved.push("resume upload"));
    // Workable parses the file server-side; give the chip time to render so
    // the submit click isn't racing the upload.
    await page.waitForTimeout(4000);
  }

  // Company questions: every keyed control, in DOM order.
  const controls = page.locator(
    'fieldset[data-ui^="QA_"], [role="group"][data-ui^="QA_"], ' +
      'input[data-ui^="QA_"], textarea[data-ui^="QA_"], input[data-ui^="CA_"]',
  );
  const n = await controls.count();
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    const key = (await el.getAttribute("data-ui")) ?? "";
    const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "");
    const label = await labelForKey(page, el, key);
    if (!label) continue;
    const required =
      (await el.getAttribute("aria-required")) === "true" ||
      (await el.getAttribute("required")) !== null ||
      (await el.locator('[aria-required="true"], [required]').count().catch(() => 0)) > 0;
    const value = answerFor(label, fields);

    if (tag === "fieldset") {
      // Radio group: click the radio whose own label matches the answer.
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      const hit = await clickChoice(el, 'input[type="radio"]', value);
      if (!hit && required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }
    if (tag === "div") {
      // Choose-one checkbox group (e.g. contact-language preference).
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      const hit = await clickChoice(el, 'input[type="checkbox"]', value);
      if (!hit && required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }
    // Text input / textarea.
    if (value == null) {
      if (required) unresolved.push(label);
      continue;
    }
    await el.fill(value).catch(() => {
      if (required) unresolved.push(label);
    });
    await humanPause();
  }

  // Select-style dropdowns: `[data-input-type="select"]` containers holding a
  // READONLY combobox input — typing is a no-op; open it and click the option
  // in its `input_<key>_listbox`.
  const selects = page.locator('[data-input-type="select"][data-ui]');
  const nSel = await selects.count();
  for (let i = 0; i < nSel; i++) {
    const box = selects.nth(i);
    const key = (await box.getAttribute("data-ui")) ?? "";
    const input = box.locator("input").first();
    if (((await input.inputValue().catch(() => "")) ?? "").trim()) continue;
    const label =
      clean(((await page.locator(`[id="${key}_label"]`).innerText().catch(() => "")) ?? "")) ||
      (await labelForKey(page, box, key));
    if (!label) continue;
    const required =
      (await box.locator('xpath=preceding-sibling::span//strong[text()="*"]').count().catch(() => 0)) > 0;
    const value = answerFor(label, fields);
    if (value == null) {
      if (required) unresolved.push(label);
      continue;
    }
    await input.click().catch(() => {});
    const opt = page
      .locator(`[id="input_${key}_listbox"] [role="option"]`, { hasText: new RegExp(escapeRe(value), "i") })
      .first();
    if (await opt.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) {
      await opt.click().catch(() => {});
    } else if (required) {
      unresolved.push(`${label} (no option matching "${value}")`);
    }
    await humanPause();
  }

  // Final verification pass: the SPA occasionally drops an earlier fill when a
  // later widget re-renders the section. Anything answered but now empty gets
  // one re-fill.
  const texts = page.locator('input[data-ui^="CA_"], input[data-ui^="QA_"], textarea[data-ui^="QA_"]');
  const nTexts = await texts.count();
  for (let i = 0; i < nTexts; i++) {
    const el = texts.nth(i);
    if (((await el.inputValue().catch(() => "")) ?? "").trim()) continue;
    const key = (await el.getAttribute("data-ui")) ?? "";
    const label = await labelForKey(page, el, key);
    if (!label) continue;
    const value = answerFor(label, fields);
    if (value == null) continue;
    await el.fill(value).catch(() => {});
    await humanPause();
  }

  return { ready: unresolved.length === 0, unresolved };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Workable's cookie-consent bar overlays the lower form and intercepts the
 *  submit click; decline the optional cookies to clear it. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const btn = page
    .locator('button:has-text("Decline all"), button:has-text("Reject all"), button:has-text("Decline optional")')
    .first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

/** Field label, most-authoritative source first: aria-labelledby (Workable
 *  puts group/question text there), label[for] against the element id and the
 *  data-ui key, aria-label, then a fieldset legend. Never scan inside the
 *  control for a bare <label> — that returns the first option's text. */
async function labelForKey(page: Page, el: Locator, key: string): Promise<string> {
  const labelledBy = await el.getAttribute("aria-labelledby");
  if (labelledBy) {
    let t = "";
    for (const id of labelledBy.split(/\s+/)) {
      t += " " + (((await page.locator(`[id="${id}"]`).first().innerText().catch(() => "")) ?? ""));
    }
    if (t.trim()) return clean(t);
  }
  // Workable renders most question labels as a sibling span id'd `<key>_label`.
  if (key) {
    const sib = page.locator(`[id="${key}_label"]`);
    if (await sib.count()) {
      const t = ((await sib.first().innerText().catch(() => "")) ?? "").trim();
      if (t) return clean(t);
    }
  }
  const ownId = await el.getAttribute("id");
  for (const k of [ownId, key]) {
    if (!k) continue;
    const lab = page.locator(`label[for="${k}"]`);
    if (await lab.count()) {
      const t = ((await lab.first().innerText().catch(() => "")) ?? "").trim();
      if (t) return clean(t);
    }
  }
  const aria = await el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const legend = await el.locator("legend").first().innerText().catch(() => "");
  return legend?.trim() ? clean(legend) : "";
}

async function clickChoice(group: Locator, selector: string, value: string): Promise<boolean> {
  const options = group.locator(selector);
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const id = await opt.getAttribute("id");
    let text = "";
    if (id) {
      text = ((await group.locator(`label[for="${id}"]`).innerText().catch(() => "")) ?? "").trim();
    }
    if (!text) {
      text = ((await opt.locator("xpath=ancestor::label[1]").innerText().catch(() => "")) ?? "").trim();
    }
    const t = text.replace(/svgs not supported by this browser\.?/gi, "").trim().toLowerCase();
    const v = value.trim().toLowerCase();
    if (t === v || t.startsWith(v) || t.includes(v)) {
      await opt.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\*\s*$/, "").trim();
}

function humanPause(): Promise<void> {
  const ms = 250 + Math.random() * 600;
  return new Promise((r) => setTimeout(r, ms));
}
