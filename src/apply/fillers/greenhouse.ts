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

  // Let the generic walker handle any remaining required custom questions and
  // report anything it can't answer for the human.
  return fillGeneric(page, fields, resumePath);
}

export const GREENHOUSE_SUBMIT = 'button[type="submit"], input[type="submit"], #submit_app';
