/**
 * Ashby-hosted application form (jobs.ashbyhq.com). Every field sits in an
 * `ashby-application-form-field-entry` container with a label element, so we
 * walk containers instead of bare inputs. Two Ashby quirks drive the shape of
 * this filler:
 *   1. Uploading a resume triggers an async "autofill from resume" parse that
 *      overwrites text fields several seconds later — so upload first, wait
 *      for the parse to settle, then fill (our values win).
 *   2. Required-ness lives on a styled asterisk element in the container, not
 *      on the input, and radio groups / Yes-No button toggles carry no form
 *      attributes at all.
 */
import type { Page, Locator } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { answerFor } from "../field-map.js";
import type { FillOutcome } from "./generic.js";

const ENTRY = ".ashby-application-form-field-entry, [class*='_fieldEntry']";

export async function fillAshby(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  coverLetter?: { path: string; text: string },
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  // Resume first: the upload kicks off Ashby's autofill parse. Wait for the
  // completion banner (or give up quietly) so later fills aren't overwritten.
  const resume = page.locator('input[type="file"]').first();
  if (await resume.count()) {
    await resume.setInputFiles(resumePath).catch(() => {});
    await page
      .locator("text=/autofill completed/i")
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  }

  const entries = page.locator(ENTRY);
  const n = await entries.count();
  for (let i = 0; i < n; i++) {
    const entry = entries.nth(i);
    const label = (
      await entry
        .locator("label, [class*='question-title']")
        .first()
        .innerText()
        .catch(() => "")
    )
      .replace(/\*\s*$/, "")
      .trim();
    if (!label || /^resume$/i.test(label)) continue;

    // Cover letter entry: Ashby offers a file upload; send ours if we have one.
    // The input rejects .txt (accept= pdf/doc/docx/odt/rtf), so prefer a .pdf
    // rendered next to the stored .txt when it exists.
    if (/cover letter/i.test(label)) {
      const file = entry.locator('input[type="file"]');
      if (coverLetter && (await file.count())) {
        let path = coverLetter.path;
        if (path.endsWith(".txt")) {
          const pdf = path.replace(/\.txt$/, ".pdf");
          const { existsSync } = await import("node:fs");
          if (existsSync(pdf)) path = pdf;
        }
        if (!path.endsWith(".txt")) {
          await file.first().setInputFiles(path).catch(() => {});
          await page.waitForTimeout(500);
        }
      }
      continue;
    }

    const required =
      (await entry.locator("[class*='required' i], abbr").count()) > 0 ||
      (await entry.locator("[required], [aria-required='true']").count()) > 0;
    const value = answerFor(label, fields);

    // Radio group: click the option whose own label matches the answer.
    const radios = entry.locator('input[type="radio"]');
    if (await radios.count()) {
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      const hit = await clickOptionByLabel(page, entry, radios, value);
      if (!hit && required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }

    // Yes/No segmented button toggle.
    const toggle = entry.locator("button", { hasText: /^(yes|no)$/i });
    if ((await toggle.count()) >= 2) {
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      const btn = entry.locator("button", { hasText: new RegExp(`^${escapeRe(value)}$`, "i") }).first();
      if (await btn.count()) await btn.click().catch(() => {});
      else if (required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }

    // Combobox (searchable select): type the answer, commit the first option.
    const combo = entry.locator('input[role="combobox"]');
    if (await combo.count()) {
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      const box = combo.first();
      await box.click().catch(() => {});
      await box.pressSequentially(value, { delay: 40 }).catch(() => {});
      const opt = page.locator('[role="option"]:visible').first();
      let appeared = await opt.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      if (!appeared && value.includes(",")) {
        // Location-style comboboxes often only match on the city segment.
        await box.fill("").catch(() => {});
        await box.pressSequentially(value.split(",")[0]!, { delay: 40 }).catch(() => {});
        appeared = await opt.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      }
      if (appeared) await opt.click().catch(() => {});
      else if (required) unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }

    // Plain text input / textarea.
    const text = entry.locator(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea',
    );
    if (await text.count()) {
      if (value == null) {
        if (required) unresolved.push(label);
        continue;
      }
      await text.first().fill(value).catch(() => {
        if (required) unresolved.push(label);
      });
      continue;
    }

    // Checkbox (consent): only ever check on an explicit approved answer.
    const checkbox = entry.locator('input[type="checkbox"]');
    if (await checkbox.count()) {
      if (value != null && /^(yes|true|checked)$/i.test(value)) {
        await checkbox.first().check({ force: true }).catch(() => {
          if (required) unresolved.push(label);
        });
      } else if (required) {
        unresolved.push(label);
      }
    }
  }

  return { ready: unresolved.length === 0, unresolved };
}

async function clickOptionByLabel(
  page: Page,
  entry: Locator,
  radios: Locator,
  value: string,
): Promise<boolean> {
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const id = await radios.nth(i).getAttribute("id");
    if (!id) continue;
    const lab = entry.locator(`label[for="${id}"]`);
    const text = ((await lab.innerText().catch(() => "")) ?? "").trim();
    if (text.toLowerCase() === value.toLowerCase()) {
      await (await lab.count() ? lab : radios.nth(i)).click().catch(() => {});
      return true;
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
