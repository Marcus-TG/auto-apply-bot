/**
 * Interactive (supervised) submission runner — the tool a Claude session or a
 * human operator drives for the final mile, where bespoke questions live.
 *
 *   SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts        # DRY_RUN honors .env
 *   DRY_RUN=false SUBMIT_JOB_ID=<id> npx tsx scripts/submit-interactive.ts
 *
 * Per-job inputs under artifacts/<id>/:
 *   answers.json      [{ "match": "<label substring>", "value": "<answer>" }]
 *                     Human-approved answers for custom questions (essays,
 *                     consents). Checked before every generic field rule.
 *   verify-code.txt   Greenhouse emails an 8-char security code at submit time;
 *                     drop it in this file (the run polls for it, so it can be
 *                     written while the browser session waits).
 *
 * Outputs: presubmit.png (filled form), postsubmit.png / after-code.png,
 * submit-progress.log. On confirmed submission: submissions row + status.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config/index.js";
import { jobs, applications, submissions, events } from "../src/store/repositories.js";
import { buildApplicantFields } from "../src/apply/index.js";
import { answerFor } from "../src/apply/field-map.js";
import { CONFIRMATION_RE } from "../src/apply/index.js";
import { fillGreenhouse, GREENHOUSE_SUBMIT } from "../src/apply/fillers/greenhouse.js";
import { fillLever, LEVER_SUBMIT } from "../src/apply/fillers/lever.js";
import { fillAshby } from "../src/apply/fillers/ashby.js";
import { detectAts } from "../src/apply/ats-detect.js";
import { detectChallenge } from "../src/apply/captcha.js";

// Ashby renders a classed <button> with no type attribute; fall back on text.
const ASHBY_SUBMIT =
  'button.ashby-application-form-submit-button, button:has-text("Submit Application"), button[type="submit"]';

const ID = process.env.SUBMIT_JOB_ID ?? "";
if (!/^[0-9a-f]{16}$/.test(ID)) {
  console.error("Set SUBMIT_JOB_ID to a job id.");
  process.exit(1);
}
const ART = resolve(process.cwd(), config.env.artifactsDir, ID);
const CODE_FILE = resolve(ART, "verify-code.txt");
const log = (msg: string) => {
  console.log(msg);
  try {
    appendFileSync(resolve(ART, "submit-progress.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
};
const readCode = () => (existsSync(CODE_FILE) ? readFileSync(CODE_FILE, "utf8").trim() : "");

/** Newest code the n8n courier delivered after `sinceMs`, preferring emails
 *  whose subject names this job's company. Falls back to "" when none. */
function courierCode(sinceMs: number, company: string): string {
  const file = resolve(process.cwd(), "data", "verify-codes.jsonl");
  if (!existsSync(file)) return "";
  const entries = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { code: string; subject: string | null; at: string }];
      } catch {
        return [];
      }
    })
    .filter((e) => Date.parse(e.at) > sinceMs)
    .filter((e) => !e.subject || e.subject.toLowerCase().includes(company.toLowerCase()));
  return entries.at(-1)?.code ?? "";
}

async function main() {
  const job = jobs.get(ID);
  const app = applications.get(ID);
  if (!job || !app) throw new Error("missing job or tailored application");
  if (submissions.has(ID)) {
    log("already submitted — nothing to do");
    return;
  }
  const profile = JSON.parse(readFileSync(resolve(process.cwd(), "config/profile.json"), "utf8"));
  const fields = buildApplicantFields(profile);
  const answersPath = resolve(ART, "answers.json");
  if (existsSync(answersPath)) {
    fields.custom = JSON.parse(readFileSync(answersPath, "utf8"));
    log(`loaded ${fields.custom!.length} custom answers`);
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(job.applyUrl ?? job.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    if (await detectChallenge(page)) throw new Error("blocking captcha/interstitial — hand off to human");
    const bodyText = ((await page.locator("body").innerText().catch(() => "")) ?? "").toLowerCase();
    if (/page not found|no longer (open|accepting)|job you.re looking for/.test(bodyText)) {
      throw new Error("posting page is dead or closed — check the job URL / liveness");
    }

    const ats = await detectAts(page);
    const coverLetter = { path: app.coverLetterPath, text: app.coverLetterText };
    const outcome =
      ats === "lever"
        ? await fillLever(page, fields, app.resumePath, coverLetter)
        : ats === "ashby"
          ? await fillAshby(page, fields, app.resumePath, coverLetter)
          : await fillGreenhouse(page, fields, app.resumePath, coverLetter);
    if (!outcome.ready) {
      log(`UNRESOLVED required fields — answer these in answers.json:\n  - ${outcome.unresolved.join("\n  - ")}`);
      await page.screenshot({ path: resolve(ART, "presubmit.png"), fullPage: true });
      process.exit(2);
    }
    await page.screenshot({ path: resolve(ART, "presubmit.png"), fullPage: true });
    log("form filled clean; presubmit.png saved");

    if (config.env.dryRun) {
      const committed = await page
        .locator(".select__single-value, .select__multi-value__label")
        .allInnerTexts()
        .catch(() => [] as string[]);
      if (committed.length) log(`dry-run dropdown values: ${JSON.stringify(committed)}`);
      log("DRY_RUN — stopping before the submit click");
      return;
    }

    const clickedAt = Date.now();
    const submitSel =
      ats === "lever" ? LEVER_SUBMIT : ats === "ashby" ? ASHBY_SUBMIT : GREENHOUSE_SUBMIT;
    await page.locator(submitSel).last().click();
    await page.waitForTimeout(4000);

    // Success, or a Greenhouse security-code gate — poll for the emailed code
    // (manual drop file first, then whatever the n8n courier delivered).
    let lastTried = "";
    let correctionTries = 0;
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const body = ((await page.locator("body").innerText().catch(() => "")) ?? "").toLowerCase();
      // Ashby "Your form needs corrections" banner: a control we filled can
      // come back empty when its React state never committed (currency inputs
      // are the known case). Re-fill whatever is blank with key events — the
      // most committed input path — and resubmit.
      if (correctionTries < 3 && /needs corrections|missing entry for required field/.test(body)) {
        correctionTries++;
        // The banner names each missing field; re-apply exactly those answers
        // with key events (React state can drop a value the DOM still shows).
        const missing = (await page.locator('li:has-text("Missing entry")').allInnerTexts().catch(() => [] as string[]))
          .map((t) => t.replace(/missing entry for required field:?/i, "").trim().toLowerCase())
          .filter(Boolean);
        log(`corrections banner (attempt ${correctionTries}): ${missing.join(" | ") || "(labels not parsed)"}`);
        const entries = page.locator(".ashby-application-form-field-entry, [class*='_fieldEntry']");
        const total = await entries.count();
        for (let i = 0; i < total; i++) {
          const entry = entries.nth(i);
          const label = ((await entry.locator("label, [class*='question-title']").first().innerText().catch(() => "")) ?? "")
            .replace(/\*\s*$/, "")
            .trim();
          if (!label) continue;
          const l40 = label.toLowerCase().slice(0, 40);
          const flagged = missing.length
            ? missing.some((m) => m.slice(0, 40) === l40 || m.startsWith(l40) || label.toLowerCase().startsWith(m.slice(0, 40)))
            : true;
          if (!flagged) continue;
          const value = answerFor(label, fields);
          if (value == null) continue;
          const toggle = entry.locator("button", { hasText: /^(yes|no)$/i });
          if ((await toggle.count()) >= 2 && /^(yes|no)$/i.test(value)) {
            log(`re-clicking toggle "${label.slice(0, 60)}" -> ${value}`);
            await entry.locator("button", { hasText: new RegExp(`^${value}$`, "i") }).first().click().catch(() => {});
            continue;
          }
          const checkbox = entry.locator('input[type="checkbox"]');
          if ((await checkbox.count()) && /^(yes|true|checked)$/i.test(value)) {
            log(`re-checking "${label.slice(0, 60)}"`);
            const cb = checkbox.first();
            // Cycle through real click events so React state commits even when
            // the DOM already shows the box as checked.
            await cb.uncheck({ force: true }).catch(() => {});
            await cb.click({ force: true }).catch(() => {});
            continue;
          }
          const input = entry.locator('input[type="text"], input[type="number"], input:not([type]), textarea').first();
          if (!(await input.count())) continue;
          log(`re-typing "${label.slice(0, 60)}"`);
          await input.click().catch(() => {});
          await input.fill("").catch(() => {});
          await input.pressSequentially(value.slice(0, 4000), { delay: 10 }).catch(() => {});
          await input.press("Tab").catch(() => {});
        }
        await page.locator(submitSel).last().click().catch(() => {});
        await page.waitForTimeout(4000);
        continue;
      }
      // The job description itself can contain phrases like "we thank you",
      // which CONFIRMATION_RE matches. Only trust it once the security-code
      // gate is gone AND the submit button has left the page.
      const codeGate = /security code|verification code/.test(body);
      const submitStillThere = (await page.locator(submitSel).count().catch(() => 0)) > 0;
      if (!codeGate && !submitStillThere && CONFIRMATION_RE.test(body)) {
        await page.screenshot({ path: resolve(ART, "postsubmit.png") });
        submissions.record(ID, page.url());
        jobs.setStatus(ID, "submitted");
        events.log({ jobId: ID, kind: "submitted", data: { ats } });
        log(`CONFIRMED SUBMITTED: ${page.url()}`);
        return;
      }
      if (!codeGate) {
        await page.screenshot({ path: resolve(ART, "postsubmit.png") });
        log("no confirmation and no code gate — inspect postsubmit.png");
      }
      const code = readCode() || courierCode(clickedAt, job.company);
      if (code && code !== lastTried) {
        lastTried = code;
        log(`entering code ${code}`);
        try {
          const boxes = page.locator(
            'input[autocomplete="one-time-code"], input[name*="security" i], input[id*="security" i], input[name*="code" i], input[id*="code" i]',
          );
          const n = await boxes.count();
          if (n === 1) await boxes.first().fill(code, { timeout: 10000 });
          else for (let i = 0; i < Math.min(n, code.length); i++) await boxes.nth(i).fill(code[i]!, { timeout: 5000 });
          await page.waitForTimeout(500);
          const btn = page.locator(GREENHOUSE_SUBMIT).last();
          if (await btn.isEnabled({ timeout: 5000 }).catch(() => false)) await btn.click().catch(() => {});
          await page.waitForTimeout(4000);
          await page.screenshot({ path: resolve(ART, "after-code.png") });
        } catch (e) {
          log(`code attempt error: ${String(e).slice(0, 200)}`);
        }
      }
      await page.waitForTimeout(3000);
    }
    log("TIMED OUT waiting for confirmation/code");
    process.exit(3);
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  log(`FAILED: ${String(e).slice(0, 300)}`);
  process.exit(1);
});
