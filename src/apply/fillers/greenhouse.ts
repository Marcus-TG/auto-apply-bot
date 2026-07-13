/**
 * Greenhouse embedded application form. Greenhouse uses stable field ids
 * (first_name, last_name, email, phone) and a resume dropzone, so we can fill it
 * more precisely than the generic walker, then fall back to generic for the rest.
 */
import type { Page } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { fillGeneric, type FillOutcome } from "./generic.js";

export async function fillGreenhouse(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  coverLetter?: { path: string; text: string },
): Promise<FillOutcome> {
  const set = async (selector: string, value: string) => {
    const el = page.locator(selector).first();
    if (await el.count()) await el.fill(value);
  };
  await set("#first_name", fields.firstName);
  await set("#last_name", fields.lastName);
  await set("#email", fields.email);
  await set("#phone", fields.phone);

  const resume = page.locator('input[type="file"]#resume, input[type="file"]').first();
  if (await resume.count()) await resume.setInputFiles(resumePath).catch(() => {});

  // Cover letter: attach the file when the board offers an upload; otherwise
  // use the paste-in textarea (hidden behind an "enter manually" toggle on
  // some boards).
  if (coverLetter) {
    const clFile = page.locator('input[type="file"]#cover_letter');
    if (await clFile.count()) {
      await clFile.setInputFiles(coverLetter.path).catch(() => {});
    } else {
      const manualToggle = page
        .locator('button:has-text("manually"), a:has-text("manually"), [data-source="paste"]')
        .first();
      if (await manualToggle.count()) await manualToggle.click().catch(() => {});
      const textarea = page.locator('#cover_letter_text, textarea[name*="cover" i]').first();
      if (await textarea.count()) await textarea.fill(coverLetter.text).catch(() => {});
    }
  }

  // Location (City) on new job boards is a react-select autocomplete: a plain
  // fill() never registers a value, so type and commit the first suggestion.
  const loc = page.locator("#candidate-location").first();
  if (await loc.count()) {
    await loc.click().catch(() => {});
    await loc.pressSequentially(fields.location, { delay: 60 }).catch(() => {});
    // ".select__option" scoped and :visible — a bare [role="option"] matches the
    // hidden phone-widget country list and clicks nothing.
    const opt = page.locator(".select__option:visible").first();
    const appeared = await opt.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
    if (!appeared) {
      await loc.fill("").catch(() => {});
      await loc.pressSequentially(fields.location.split(",")[0]!, { delay: 60 }).catch(() => {});
      await opt.waitFor({ timeout: 6000 }).catch(() => {});
    }
    if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
  }

  // Let the generic walker handle any remaining required custom questions and
  // report anything it can't answer for the human.
  return fillGeneric(page, fields, resumePath);
}

export const GREENHOUSE_SUBMIT = 'button[type="submit"], input[type="submit"], #submit_app';
