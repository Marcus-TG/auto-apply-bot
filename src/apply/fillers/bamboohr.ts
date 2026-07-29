/**
 * BambooHR-hosted careers form (<tenant>.bamboohr.com/careers/<id>). The page
 * is a client-side SPA: the job description renders first and the application
 * form only mounts after the Apply button is clicked, on the same route.
 * Stable hooks once mounted:
 *   - Identity/address inputs carry plain `name` attributes (firstName,
 *     lastName, email, phone, streetAddress.value, city.value, zip.value).
 *   - Province and country are native <select>s (state.value, countryId.value).
 *   - Two unlabeled file inputs in DOM order: cover letter first, resume
 *     second (the required one, its Choose File button is starred).
 *   - A honeypot text input ("Please leave this field blank") must stay empty.
 *   - reCAPTCHA fires on submit; expect a possible human handoff there.
 */
import type { Page } from "playwright";
import type { ApplicantFields } from "../field-map.js";
import { answerFor } from "../field-map.js";
import { findOption, type FillOutcome } from "./generic.js";

export const BAMBOO_SUBMIT = 'button:has-text("Submit Application")';

export async function fillBambooHR(
  page: Page,
  fields: ApplicantFields,
  resumePath: string,
  coverLetter?: { path: string },
): Promise<FillOutcome> {
  const unresolved: string[] = [];

  // Reveal the form if the page is still showing the job description.
  if (!(await page.locator('input[name="firstName"]').count())) {
    const apply = page.locator('a:has-text("Apply"), button:has-text("Apply")').first();
    if (await apply.count()) {
      await apply.click().catch(() => {});
      await page
        .waitForSelector('input[name="firstName"]', { timeout: 10000 })
        .catch(() => {});
    }
  }
  if (!(await page.locator('input[name="firstName"]').count())) {
    return { ready: false, unresolved: ["application form did not mount after Apply click"] };
  }

  const fillByName = async (name: string, value: string | undefined | null, label: string, required = false) => {
    if (value == null || value === "") {
      if (required) unresolved.push(label);
      return;
    }
    const el = page.locator(`input[name="${name}"], textarea[name="${name}"]`).first();
    if (!(await el.count())) {
      if (required) unresolved.push(label);
      return;
    }
    await el.fill(value).catch(() => {
      if (required) unresolved.push(label);
    });
    await humanPause();
  };

  await fillByName("firstName", fields.firstName, "First Name", true);
  await fillByName("lastName", fields.lastName, "Last Name", true);
  await fillByName("email", fields.email, "Email", true);
  await fillByName("phone", fields.phone, "Phone", true);
  await fillByName("streetAddress.value", fields.address?.street, "Address", true);
  await fillByName("city.value", fields.address?.city ?? fields.location, "City", true);
  await fillByName("zip.value", fields.address?.postal, "Postal Code", true);
  await fillByName("linkedinUrl", fields.linkedin, "LinkedIn URL");
  await fillByName("websiteUrl", fields.portfolio, "Website, Blog or Portfolio");
  await fillByName("desiredPay", answerFor("salary", fields), "Desired Pay");

  // Native selects: match the option text, never a bare two-letter code.
  await selectByName(page, "state.value", answerFor("province", fields), "Province", unresolved);
  await selectByName(page, "countryId.value", fields.country, "Country", unresolved);

  // File inputs are unlabeled; DOM order is cover letter, then resume (required).
  const files = page.locator('input[type="file"]');
  const nFiles = await files.count();
  if (nFiles === 0) {
    unresolved.push("resume upload (no file input found)");
  } else {
    const resumeInput = files.nth(nFiles > 1 ? 1 : 0);
    await resumeInput.setInputFiles(resumePath).catch(() => unresolved.push("resume upload"));
    if (nFiles > 1 && coverLetter?.path) {
      await files.nth(0).setInputFiles(coverLetter.path).catch(() => {});
    }
    // The chip renders client-side; don't let the submit click race it.
    await page.waitForTimeout(2000);
  }

  return { ready: unresolved.length === 0, unresolved };
}

async function selectByName(
  page: Page,
  name: string,
  value: string | null,
  label: string,
  unresolved: string[],
): Promise<void> {
  // The native select is an empty stub (`chzn-ignore`, zero real options); the
  // working control is a Fabric toggle button whose aria-label is
  // "<label> <current value>", opening a menu of li options on click.
  const btn = page
    .locator(`.fab-Select:has(select[name="${name}"]) button.fab-SelectToggle`)
    .first();
  if (!(await btn.count())) {
    if (value != null) unresolved.push(`${label} (widget not found)`);
    return;
  }
  const current = ((await btn.innerText().catch(() => "")) ?? "").trim();
  const alreadySet = current !== "" && !/^[-–—]*\s*select\s*[-–—]*$/i.test(current);
  if (value == null) {
    if (!alreadySet) unresolved.push(label);
    return;
  }
  if (alreadySet && findOption([current], value)) return;
  // The menu portal mounts async; wait for options and re-open once if the
  // first click raced the mount.
  let items: string[] = [];
  const menu = page.locator('[role="listbox"], [id^="fab-menu"], ul').last();
  for (let attempt = 0; attempt < 2 && items.length === 0; attempt++) {
    await btn.click().catch(() => {});
    await menu
      .locator('[role="option"], [role="menuitem"], li')
      .first()
      .waitFor({ timeout: 4000 })
      .catch(() => {});
    items = await menu
      .locator('[role="option"], [role="menuitem"], li')
      .allInnerTexts()
      .catch(() => [] as string[]);
  }
  const hit = findOption(items.map((t) => t.trim()).filter(Boolean), value);
  if (!hit) {
    // A pre-selected default (BambooHR geo-defaults Country) is acceptable.
    if (!alreadySet) unresolved.push(`${label} (no option matching "${value}")`);
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }
  const ok = await menu
    .locator('[role="option"], [role="menuitem"], li')
    .filter({ hasText: hit })
    .first()
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) unresolved.push(label);
  await humanPause();
}

function humanPause(): Promise<void> {
  const ms = 250 + Math.random() * 600;
  return new Promise((r) => setTimeout(r, ms));
}
