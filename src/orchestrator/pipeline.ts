/**
 * The pipeline: the glue that walks jobs through the state machine. n8n calls
 * these functions over HTTP (see src/server.ts), or the CLI calls them directly.
 * Each stage is independently runnable so you can re-drive a single step.
 *
 *   discover → score → tailor → gate → (human) → submit
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config/index.js";
import { jobs, scores, applications, events } from "../store/repositories.js";
import { runDiscovery } from "../discovery/index.js";
import { scoreJob, type CandidateProfile } from "../scoring/index.js";
import { loadVariants, variantSummaries, getVariant } from "../resume/selector.js";
import { tailorResume } from "../resume/tailor.js";
import { renderResumePdf, resumeIdentityFromProfile } from "../resume/render.js";
import { generateCoverLetter } from "../coverletter/generator.js";
import { requestApproval } from "../approval/index.js";
import { notifyN8n } from "../approval/notify.js";
import { submitApplication, buildApplicantFields } from "../apply/index.js";
import type { TailoredApplication } from "../types/index.js";

// Returns `any` because the profile JSON is user-authored and consumed by several
// modules with differing shapes (scoring, field-map, cover letter). Each validates
// what it needs.
function loadProfile(): any {
  // Prefer the real profile.json; fall back to the committed example.
  const candidates = ["config/profile.json", "config/profile.example.json"];
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf8"));
    } catch {
      /* try next */
    }
  }
  throw new Error("No candidate profile found (config/profile.json).");
}

/** Stage 1: discover new postings. */
export async function discover() {
  return runDiscovery();
}

/** Stage 2: score everything currently in `discovered`.
 *
 * Runs SCORING_CONCURRENCY jobs at once (default 2). With a pooled
 * LOCAL_LLM_BASE_URL the round-robin then keeps every endpoint busy
 * simultaneously instead of alternating one call at a time. */
export async function scoreNewJobs() {
  const profile = loadProfile();
  const variants = loadVariants();
  const summaries = variantSummaries(variants);
  const pending = jobs.byStatus("discovered");
  const results: { jobId: string; lane?: string; filtered?: string }[] = [];

  const concurrency = Math.max(1, Number(process.env.SCORING_CONCURRENCY ?? 2));
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const job = pending[next++]!;
      try {
        const outcome = await scoreJob(job, profile, summaries);
        if (outcome.filtered) {
          jobs.setStatus(job.id, "prefiltered_out");
          events.log({ jobId: job.id, kind: "prefiltered", data: { reason: outcome.filtered } });
          results.push({ jobId: job.id, filtered: outcome.filtered });
          continue;
        }
        scores.save(outcome.score!, outcome.lane!);
        jobs.setStatus(job.id, outcome.lane === "reject" ? "rejected" : "scored");
        events.log({ jobId: job.id, kind: "scored", data: { overall: outcome.score!.overall, lane: outcome.lane } });
        results.push({ jobId: job.id, lane: outcome.lane });
      } catch (err) {
        jobs.setStatus(job.id, "failed");
        events.log({ jobId: job.id, kind: "score_error", data: { error: String(err) } });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return results;
}

/** Stage 3: tailor materials for scored jobs that are in an apply/review lane. */
export async function tailorScoredJobs(baseUrl: string) {
  const profile = loadProfile();
  const variants = loadVariants();
  const scored = jobs.byStatus("scored");
  const out: { jobId: string; lane: string }[] = [];

  for (const job of scored) {
    const score = scores.get(job.id);
    if (!score) continue;
    try {
      jobs.setStatus(job.id, "tailoring");
      const variant = getVariant(variants, score.recommendedVariant);
      const rendered = await tailorResume(job, variant, score);
      const { pdfPath, jsonPath } = await renderResumePdf(
        rendered,
        resumeIdentityFromProfile(profile.identity),
        job.id,
      );
      const letter = await generateCoverLetter(job, rendered, score, profile.identity, profile.voice.sample);

      const app: TailoredApplication = {
        jobId: job.id,
        variantId: variant.id,
        resumePath: pdfPath,
        resumeJsonPath: jsonPath,
        coverLetterPath: letter.path,
        coverLetterText: letter.text,
        createdAt: new Date().toISOString(),
      };
      applications.save(app);
      events.log({ jobId: job.id, kind: "tailored", data: { variant: variant.id } });

      if (score.lane === "auto") {
        // Mid-band + auto-apply enabled: skip the human gate, go straight to approved.
        jobs.setStatus(job.id, "approved");
        out.push({ jobId: job.id, lane: "auto" });
      } else {
        // review lane: create the approval request and notify.
        const card = requestApproval(job, baseUrl);
        await notifyN8n(card);
        out.push({ jobId: job.id, lane: "review" });
      }
    } catch (err) {
      jobs.setStatus(job.id, "failed");
      events.log({ jobId: job.id, kind: "tailor_error", data: { error: String(err) } });
    }
  }
  return out;
}

/** Stage 4: submit everything currently `approved`. */
export async function submitApproved() {
  const profile = loadProfile();
  const fields = buildApplicantFields(profile);
  const approved = jobs.byStatus("approved");
  const out: { jobId: string; status: string; reason?: string }[] = [];

  for (const job of approved) {
    const app = applications.get(job.id);
    if (!app) continue;
    jobs.setStatus(job.id, "submitting");
    const result = await submitApplication(job, app, fields);
    if (result.status === "submitted") {
      jobs.setStatus(job.id, "submitted");
      out.push({ jobId: job.id, status: "submitted" });
    } else if (result.status === "needs_human") {
      jobs.setStatus(job.id, "needs_human");
      out.push({ jobId: job.id, status: "needs_human", reason: result.reason });
    } else {
      jobs.setStatus(job.id, "failed");
      out.push({ jobId: job.id, status: "failed", reason: result.error });
    }
  }
  return out;
}

/** Convenience: run the whole non-human portion end to end. */
export async function runPipeline(baseUrl: string) {
  const discovered = await discover();
  const scoredResults = await scoreNewJobs();
  const tailored = await tailorScoredJobs(baseUrl);
  const submitted = await submitApproved(); // submits auto-lane + any already-approved
  return { discovered, scored: scoredResults.length, tailored: tailored.length, submitted };
}
