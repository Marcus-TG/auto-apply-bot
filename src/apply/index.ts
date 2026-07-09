/**
 * Submission orchestrator. Given an approved job + its tailored materials, drive a
 * browser to fill and submit the application. Enforces the safety invariants:
 *
 *  - DRY_RUN never clicks submit (fills + screenshots only).
 *  - Idempotent: a job already in `submissions` is never re-submitted.
 *  - Rate-limited: respects MAX_SUBMISSIONS_PER_DAY.
 *  - Fails safe: CAPTCHA, unknown required fields, or login walls → needs_human
 *    (with a live-view URL when the provider offers one), never a blind submit.
 */
import type { Page } from "playwright";
import { config } from "../config/index.js";
import { events, submissions } from "../store/repositories.js";
import type { JobPosting, TailoredApplication, SubmitResult } from "../types/index.js";
import { browserProvider } from "./browser.js";
import { detectAts } from "./ats-detect.js";
import { detectChallenge } from "./captcha.js";
import { buildFields, type ApplicantFields } from "./field-map.js";
import { fillGeneric, type FillOutcome } from "./fillers/generic.js";
import { fillGreenhouse, GREENHOUSE_SUBMIT } from "./fillers/greenhouse.js";
import { fillLever, LEVER_SUBMIT } from "./fillers/lever.js";
import { runAgenticApplication } from "./agentic.js";

export function buildApplicantFields(profile: Parameters<typeof buildFields>[0]): ApplicantFields {
  return buildFields(profile);
}

export async function submitApplication(
  job: JobPosting,
  app: TailoredApplication,
  fields: ApplicantFields,
): Promise<SubmitResult> {
  // --- idempotency + rate limit (checked before opening a browser) ---
  if (submissions.has(job.id)) {
    return { status: "submitted", confirmation: "already-submitted" };
  }
  if (submissions.countLast24h() >= config.env.maxSubmissionsPerDay) {
    events.log({ jobId: job.id, kind: "rate_limited", data: {} });
    return { status: "needs_human", reason: "daily submission cap reached", liveViewUrl: null };
  }

  const provider = browserProvider();
  const session = await provider.open();
  const page = session.page;

  try {
    await page.goto(job.applyUrl ?? job.url, { waitUntil: "domcontentloaded" });

    if (await detectChallenge(page)) {
      events.log({ jobId: job.id, kind: "captcha_detected", data: { provider: provider.kind } });
      return {
        status: "needs_human",
        reason: "CAPTCHA / anti-bot challenge — complete it via live view",
        liveViewUrl: session.liveViewUrl,
      };
    }

    const ats = await detectAts(page);

    // Unknown/custom/layered sites (Phenom→iCIMS, bespoke portals) have no hardcoded
    // filler — drive them with the AI browser agent, which owns its own submit + handoff.
    if (ats === "unknown" && config.env.agenticFallback) {
      return await runAgenticApplication(page, job, app, fields, session.liveViewUrl);
    }

    const outcome = await runFiller(ats, page, fields, app);

    // Anything unresolved → stop and ask the human. Never submit a partial form.
    if (!outcome.ready) {
      events.log({ jobId: job.id, kind: "needs_human_fields", data: { unresolved: outcome.unresolved } });
      return {
        status: "needs_human",
        reason: `unresolved required fields: ${outcome.unresolved.join(", ")}`,
        liveViewUrl: session.liveViewUrl,
      };
    }

    // Save a pre-submit screenshot for the audit trail.
    await page.screenshot({ path: app.resumePath.replace(/resume\.pdf$/, "presubmit.png") }).catch(() => {});

    if (config.env.dryRun) {
      events.log({ jobId: job.id, kind: "dry_run_submit", data: { ats } });
      return { status: "submitted", confirmation: "DRY_RUN (not actually submitted)" };
    }

    const submitSel = ats === "lever" ? LEVER_SUBMIT : GREENHOUSE_SUBMIT;
    const submitBtn = page.locator(submitSel).first();
    if (!(await submitBtn.count())) {
      return { status: "needs_human", reason: "submit button not found", liveViewUrl: session.liveViewUrl };
    }
    await submitBtn.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // Post-submit screenshot: ground truth for "did it actually go through".
    await page.screenshot({ path: app.resumePath.replace(/resume\.pdf$/, "postsubmit.png"), fullPage: true }).catch(() => {});

    const confirmation = await readConfirmation(page);
    submissions.record(job.id, confirmation);
    events.log({ jobId: job.id, kind: "submitted", data: { ats, confirmation } });
    return { status: "submitted", confirmation };
  } catch (err) {
    events.log({ jobId: job.id, kind: "submit_error", data: { error: String(err) } });
    return { status: "failed", error: String(err) };
  } finally {
    await session.close();
  }
}

async function runFiller(
  ats: string,
  page: Page,
  fields: ApplicantFields,
  app: TailoredApplication,
): Promise<FillOutcome> {
  const coverLetter = { path: app.coverLetterPath, text: app.coverLetterText };
  switch (ats) {
    case "greenhouse":
      return fillGreenhouse(page, fields, app.resumePath, coverLetter);
    case "lever":
      return fillLever(page, fields, app.resumePath, coverLetter);
    default:
      return fillGeneric(page, fields, app.resumePath);
  }
}

async function readConfirmation(page: Page): Promise<string | null> {
  const body = (await page.content()).toLowerCase();
  if (/thank you|application (has been |was )?(received|submitted)|we('|’)ve received|successfully (submitted|applied)/.test(body)) {
    return page.url();
  }
  return null;
}
