/**
 * JazzHR-hosted application form (<company>.applytojob.com). Server-rendered
 * with stable `resumator-*` input names, so fill by name rather than by label
 * (the visual labels double up: city/state/postal all sit under "Address").
 * Custom screening questions are native selects named
 * `resumator-questionnaire[<id>]` with a proper label[for].
 */
import type { Page } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { answerFor } from "../field-map.js";
import type { FillOutcome } from "./generic.js";
import { dismissCookieBanner } from "./workable.js";

export const JAZZHR_SUBMIT =
  '#resumator-submit-resume, a.btn:has-text("Submit Application"), #submit_app, button[type="submit"], input[type="submit"]';

/** name suffix → the label we pass through answerFor (keeps every value
 *  flowing through the same custom-answer / profile rules as other ATSes). */
const NAMED_FIELDS: Array<[suffix: string, label: string]> = [
  ["firstname", "first name"],
  ["lastname", "last name"],
  ["email", "email"],
  ["phone", "phone"],
  ["address", "address 1"],
  ["city", "city"],
  ["state", "province / state"],
  ["postal", "postal code"],
  ["linkedin", "linkedin"],
  ["salary", "desired salary"],
  ["start", "earliest start date"],
];

export async function fillJazzHR(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  coverLetter?: { path: string; text: string },
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  await dismissCookieBanner(page);

  const resume = page.locator('input[name="resumator-resume-value"], input[type="file"]').first();
  if (await resume.count()) {
    await resume.setInputFiles(resumePath).catch(() => unresolved.push("resume upload"));
    await page.waitForTimeout(2000);
  }

  for (const [suffix, label] of NAMED_FIELDS) {
    const el = page.locator(`input[name="resumator-${suffix}-value"]`).first();
    if (!(await el.count())) continue;
    const value = answerFor(label, fields);
    if (value == null) {
      unresolved.push(label);
      continue;
    }
    await el.fill(value).catch(() => unresolved.push(label));
    // The start-date input attaches a JS datepicker that stays open over the
    // form after a programmatic fill; Escape closes it without clearing.
    if (suffix === "start") await el.press("Escape").catch(() => {});
    await humanPause();
  }

  const cover = page.locator('textarea[name="resumator-coverletter-value"]').first();
  if (coverLetter && (await cover.count())) {
    await cover.fill(coverLetter.text).catch(() => {});
    await humanPause();
  }

  // Screening questions: native selects with a real label[for].
  const selects = page.locator('select[name^="resumator-questionnaire"]');
  const n = await selects.count();
  for (let i = 0; i < n; i++) {
    const el = selects.nth(i);
    const id = await el.getAttribute("id");
    const label = id
      ? (((await page.locator(`label[for="${id}"]`).innerText().catch(() => "")) ?? "")
          .replace(/\*\s*$/, "")
          .trim())
      : "";
    if (!label) {
      unresolved.push("(unlabelled screening question)");
      continue;
    }
    const value = answerFor(label, fields);
    if (value == null) {
      unresolved.push(label);
      continue;
    }
    const options = await el.locator("option").allInnerTexts();
    const match =
      options.find((o) => o.trim().toLowerCase() === value.toLowerCase()) ??
      options.find((o) => o.toLowerCase().includes(value.toLowerCase()));
    if (!match) {
      unresolved.push(`${label} (no option matching "${value}")`);
      continue;
    }
    await el.selectOption({ label: match }).catch(() => unresolved.push(label));
    await humanPause();
  }

  return { ready: unresolved.length === 0, unresolved };
}

function humanPause(): Promise<void> {
  const ms = 250 + Math.random() * 600;
  return new Promise((r) => setTimeout(r, ms));
}
