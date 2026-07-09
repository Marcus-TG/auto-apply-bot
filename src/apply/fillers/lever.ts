/**
 * Lever application form. Lever uses name="name", name="email", name="phone" and
 * a resume file input, with custom questions rendered below. Same pattern as
 * Greenhouse: fill the knowns precisely, then defer to the generic walker.
 */
import type { Page } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { fillGeneric, type FillOutcome } from "./generic.js";

export async function fillLever(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  coverLetter?: { path: string; text: string },
): Promise<FillOutcome> {
  const set = async (selector: string, value: string) => {
    const el = page.locator(selector).first();
    if (await el.count()) await el.fill(value);
  };
  await set('input[name="name"]', fields.fullName);
  await set('input[name="email"]', fields.email);
  await set('input[name="phone"]', fields.phone);
  await set('input[name="urls[LinkedIn]"]', fields.linkedin ?? "");

  const resume = page.locator('input[name="resume"], input[type="file"]').first();
  if (await resume.count()) await resume.setInputFiles(resumePath).catch(() => {});

  // Lever's free-text "Additional information" box is the cover letter slot.
  if (coverLetter) {
    const textarea = page.locator('textarea[name="comments"], textarea[name*="cover" i]').first();
    if (await textarea.count()) await textarea.fill(coverLetter.text).catch(() => {});
  }

  return fillGeneric(page, fields, resumePath);
}

export const LEVER_SUBMIT = 'button[type="submit"], .postings-btn-wrapper button';
