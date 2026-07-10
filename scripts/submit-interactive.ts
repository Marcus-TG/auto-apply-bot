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
import { CONFIRMATION_RE } from "../src/apply/index.js";
import { fillGreenhouse, GREENHOUSE_SUBMIT } from "../src/apply/fillers/greenhouse.js";
import { fillLever, LEVER_SUBMIT } from "../src/apply/fillers/lever.js";
import { detectAts } from "../src/apply/ats-detect.js";
import { detectChallenge } from "../src/apply/captcha.js";

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

    const ats = await detectAts(page);
    const coverLetter = { path: app.coverLetterPath, text: app.coverLetterText };
    const outcome =
      ats === "lever"
        ? await fillLever(page, fields, app.resumePath, coverLetter)
        : await fillGreenhouse(page, fields, app.resumePath, coverLetter);
    if (!outcome.ready) {
      log(`UNRESOLVED required fields — answer these in answers.json:\n  - ${outcome.unresolved.join("\n  - ")}`);
      await page.screenshot({ path: resolve(ART, "presubmit.png"), fullPage: true });
      process.exit(2);
    }
    await page.screenshot({ path: resolve(ART, "presubmit.png"), fullPage: true });
    log("form filled clean; presubmit.png saved");

    if (config.env.dryRun) {
      log("DRY_RUN — stopping before the submit click");
      return;
    }

    await page.locator(ats === "lever" ? LEVER_SUBMIT : GREENHOUSE_SUBMIT).last().click();
    await page.waitForTimeout(4000);

    // Success, or a Greenhouse security-code gate — poll for the emailed code.
    let lastTried = "";
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const body = ((await page.locator("body").innerText().catch(() => "")) ?? "").toLowerCase();
      if (CONFIRMATION_RE.test(body)) {
        await page.screenshot({ path: resolve(ART, "postsubmit.png") });
        submissions.record(ID, page.url());
        jobs.setStatus(ID, "submitted");
        events.log({ jobId: ID, kind: "submitted", data: { ats } });
        log(`CONFIRMED SUBMITTED: ${page.url()}`);
        return;
      }
      if (!/security code|verification code/.test(body)) {
        await page.screenshot({ path: resolve(ART, "postsubmit.png") });
        log("no confirmation and no code gate — inspect postsubmit.png");
      }
      const code = readCode();
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
