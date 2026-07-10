/**
 * HTTP surface that n8n drives. Two kinds of endpoints:
 *   - Pipeline triggers (/run/*) — n8n's cron workflow calls these on a schedule.
 *   - Approval webhooks (/approval/*) — the Approve/Reject links in the review
 *     notification point here; n8n can also POST decisions to /approval/:id.
 *
 * Auth is a shared secret header (x-webhook-secret) for the trigger routes; the
 * approval GET links are unguessable UUIDs so they work as one-click email links.
 */
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { config } from "./config/index.js";
import { initSchema } from "./store/db.js";
import { jobs, scores, applications, approvals, submissions, events } from "./store/repositories.js";
import { loadVariants, getVariant } from "./resume/selector.js";
import { tailorResume } from "./resume/tailor.js";
import { renderResumePdf, resumeIdentityFromProfile } from "./resume/render.js";
import { RenderedResume } from "./resume/model.js";
import { reviseCoverLetter } from "./coverletter/generator.js";
import {
  discover,
  scoreNewJobs,
  tailorScoredJobs,
  tailorOneJob,
  submitApproved,
  runPipeline,
} from "./orchestrator/pipeline.js";
import { resolveApproval, sweepExpiredApprovals } from "./approval/index.js";

initSchema();
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const baseUrl = () => config.env.publicBaseUrl || `http://localhost:${config.env.port}`;

function requireSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.header("x-webhook-secret") !== config.env.webhookSecret) {
    res.status(401).json({ error: "bad secret" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, dryRun: config.env.dryRun }));

// --- pipeline triggers (secret-guarded) ---
app.post("/run/discover", requireSecret, async (_req, res) => res.json(await discover()));
app.post("/run/score", requireSecret, async (_req, res) => res.json(await scoreNewJobs()));
app.post("/run/tailor", requireSecret, async (_req, res) => res.json(await tailorScoredJobs(baseUrl())));
app.post("/run/submit", requireSecret, async (_req, res) => res.json(await submitApproved()));
app.post("/run/all", requireSecret, async (_req, res) => res.json(await runPipeline(baseUrl())));
app.post("/run/sweep", requireSecret, (_req, res) => res.json({ expired: sweepExpiredApprovals() }));

// --- human review surface (job ids are content hashes; server is LAN-only) ---
const ARTIFACT_FILES = new Set(["resume.pdf", "cover-letter.txt", "resume.json"]);
app.get("/artifacts/:jobId/:file", (req, res) => {
  const { jobId, file } = req.params;
  if (!/^[0-9a-f]{16}$/.test(jobId) || !ARTIFACT_FILES.has(file)) {
    res.status(404).send("not found");
    return;
  }
  const path = resolve(process.cwd(), config.env.artifactsDir, jobId, file);
  if (!existsSync(path)) {
    res.status(404).send("not found");
    return;
  }
  res.sendFile(path);
});

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

app.get("/review/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  const score = scores.get(jobId);
  const application = applications.get(jobId);
  if (!job || !score || !application) {
    res.status(404).send("No reviewable application for this job.");
    return;
  }
  const approval = approvals.pendingForJob(jobId);
  const decide = approval
    ? `<a class="btn ok" href="${baseUrl()}/approval/${approval.id}/approve">Approve &amp; submit</a>
       <a class="btn no" href="${baseUrl()}/approval/${approval.id}/reject">Reject</a>
       <span class="muted">expires ${esc(approval.expires_at)}</span>`
    : `<span class="muted">No pending approval (status: ${esc(job.status)}).</span>`;
  const dims = score.dimensions
    .map((d) => `<tr><td>${esc(d.name)}</td><td><b>${d.score}</b></td><td>${esc(d.rationale)}</td></tr>`)
    .join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(job.title)} @ ${esc(job.company)}</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}
  main{max-width:900px;margin:0 auto;padding:16px}
  .card{background:#fff;border-radius:10px;padding:16px 20px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1{font-size:1.3rem;margin:0} h2{font-size:1rem;margin:0 0 8px}
  .muted{color:#78716c;font-size:.85rem}
  .btn{display:inline-block;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:8px}
  .ok{background:#16a34a;color:#fff} .no{background:#dc2626;color:#fff}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  td{border-top:1px solid #e7e5e4;padding:6px 8px;vertical-align:top}
  pre{white-space:pre-wrap;font-family:Georgia,serif;font-size:.95rem;line-height:1.5}
  textarea{width:100%;font-family:Georgia,serif;font-size:.95rem;line-height:1.5;border:1px solid #d6d3d1;border-radius:8px;padding:10px;box-sizing:border-box}
  input[name="instruction"]{width:100%;padding:9px 10px;border:1px solid #d6d3d1;border-radius:8px;margin:8px 0 4px;box-sizing:border-box}
  form{margin:8px 0}
  iframe{width:100%;height:75vh;border:1px solid #d6d3d1;border-radius:8px;background:#fff}
  .tag{display:inline-block;background:#e7e5e4;border-radius:99px;padding:2px 10px;margin:2px;font-size:.8rem}
</style></head><body><main>
  <div class="card">
    <h1>${esc(job.title)} — ${esc(job.company)}</h1>
    <p class="muted">Fit <b>${score.overall}/100</b> · confidence ${score.confidence} · variant ${esc(application.variantId)} · <a href="${esc(job.url)}">posting ↗</a></p>
    <p>${esc(score.summary)}</p>
    <p>${decide}</p>
  </div>
  <div class="card"><h2>Score breakdown</h2><table>${dims}</table>
    <p><b>Strengths:</b> ${score.matchedKeywords.map((k) => `<span class="tag">${esc(k)}</span>`).join("")}</p>
    <p><b>Gaps:</b> ${score.gapKeywords.map((k) => `<span class="tag">${esc(k)}</span>`).join("")}</p>
  </div>
  <div class="card"><h2>Cover letter</h2>
    <form method="POST" action="${baseUrl()}/review/${jobId}/letter">
      <textarea name="text" rows="16">${esc(application.coverLetterText)}</textarea>
      <button class="btn go" type="submit">Save edits</button>
    </form>
    <form method="POST" action="${baseUrl()}/review/${jobId}/letter/revise">
      <input name="instruction" placeholder="Tell the AI how to improve it, e.g. 'open with the GPU pooling story'" required>
      <button class="btn go" type="submit">Revise letter (takes ~30s)</button>
    </form>
  </div>
  <div class="card"><h2>Resume (as submitted)</h2>
    <iframe src="${baseUrl()}/artifacts/${jobId}/resume.pdf"></iframe>
    <p class="muted"><a href="${baseUrl()}/artifacts/${jobId}/resume.pdf">open PDF directly</a></p>
    <form method="POST" action="${baseUrl()}/review/${jobId}/resume/revise">
      <input name="instruction" placeholder="Direct the tailoring, e.g. 'prioritize monitoring bullets, drop the marketing one'" required>
      <button class="btn go" type="submit">Re-tailor resume (takes ~60s)</button>
    </form>
    <p class="muted">Re-tailoring re-selects bullets from your approved bank per your direction; it never writes new claims.</p>
  </div>
</main></body></html>`);
});

// The review queue: everything that cleared the score floor, waiting for a
// human skim. Materials are prepared per-job on demand (button), not in bulk.
app.get("/queue", (_req, res) => {
  const rows = [...jobs.byStatus("scored"), ...jobs.byStatus("awaiting_approval"), ...jobs.byStatus("approved")]
    .map((j) => ({ job: j, score: scores.get(j.id) }))
    .filter((r) => r.score)
    .sort((a, b) => (b.score!.overall ?? 0) - (a.score!.overall ?? 0));
  const table = rows
    .map(({ job, score }) => {
      const action =
        job.status === "scored"
          ? `<a class="btn go" href="${baseUrl()}/tailor-one/${job.id}">Prepare materials</a>
             <a class="btn no" href="${baseUrl()}/reject-job/${job.id}">Skip</a>`
          : `<a class="btn go" href="${baseUrl()}/review/${job.id}">Review & decide</a>`;
      return `<tr>
        <td><b>${score!.overall}</b></td>
        <td>${esc(job.company)}</td>
        <td><a href="${esc(job.url)}">${esc(job.title.trim())}</a></td>
        <td>${esc(job.location ?? "")}</td>
        <td>${esc(job.status)}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Review queue</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}
  main{max-width:1100px;margin:0 auto;padding:16px}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th,td{border-top:1px solid #e7e5e4;padding:8px 10px;text-align:left;font-size:.9rem;vertical-align:top}
  th{background:#fafaf9}
  .btn{display:inline-block;padding:5px 10px;border-radius:6px;text-decoration:none;font-weight:600;font-size:.8rem;margin:1px}
  .go{background:#2563eb;color:#fff} .no{background:#e7e5e4;color:#44403c}
</style></head><body><main>
  <h1>Review queue (${rows.length})</h1>
  <p><a href="${baseUrl()}/applications">→ submitted applications ledger</a></p>
  <table><tr><th>Fit</th><th>Company</th><th>Role</th><th>Location</th><th>Status</th><th></th></tr>${table}</table>
</main></body></html>`);
});

// Prepare materials for one job (async — tailoring takes ~2 min). The status
// guard inside tailorOneJob makes double-clicks harmless.
app.get("/tailor-one/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job || job.status !== "scored") {
    res.status(409).send(`Not tailorable (status: ${job?.status ?? "unknown"}). <a href="${baseUrl()}/queue">back</a>`);
    return;
  }
  void tailorOneJob(jobId, baseUrl());
  res.send(`<meta name="viewport" content="width=device-width, initial-scale=1">
    <h2>Preparing materials for ${job.title} @ ${job.company}</h2>
    <p>Resume + cover letter take about 2 minutes; a card will land in Discord and the
    <a href="${baseUrl()}/review/${jobId}">review page</a> will fill in.</p>
    <p><a href="${baseUrl()}/queue">← back to queue</a></p>`);
});

// Skip a job from the queue without preparing anything.
app.get("/reject-job/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job || job.status !== "scored") {
    res.status(409).send(`Not skippable (status: ${job?.status ?? "unknown"}). <a href="${baseUrl()}/queue">back</a>`);
    return;
  }
  jobs.setStatus(jobId, "rejected");
  events.log({ jobId, kind: "skipped_from_queue", data: {} });
  res.redirect(`${baseUrl()}/queue`);
});

// Verification-code inbox (the n8n "code courier" POSTs Greenhouse security
// codes here as they arrive by email). Waiting submit runs poll the file.
app.post("/verify-code", requireSecret, (req, res) => {
  const { code, subject } = req.body as { code?: string; subject?: string };
  if (!code || !/^[A-Za-z0-9]{6,12}$/.test(code)) {
    res.status(400).json({ error: "code must be 6-12 alphanumerics" });
    return;
  }
  const dir = resolve(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    resolve(dir, "verify-codes.jsonl"),
    JSON.stringify({ code, subject: subject ?? null, at: new Date().toISOString() }) + "\n",
  );
  res.json({ ok: true });
});

// Applications ledger: every submitted application, newest first.
app.get("/applications", (_req, res) => {
  const rows = submissions.all().map((s) => {
    const job = jobs.get(s.job_id);
    const score = scores.get(s.job_id);
    return { ...s, job, score };
  });
  const table = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.submitted_at)}</td>
        <td>${esc(r.job?.company ?? "?")}</td>
        <td><a href="${esc(r.job?.url ?? "#")}">${esc(r.job?.title?.trim() ?? r.job_id)}</a></td>
        <td>${r.score?.overall ?? ""}</td>
        <td><a href="${baseUrl()}/review/${r.job_id}">review</a> · <a href="${baseUrl()}/artifacts/${r.job_id}/resume.pdf">resume</a> · <a href="${baseUrl()}/artifacts/${r.job_id}/cover-letter.txt">letter</a></td>
        <td>${esc(r.confirmation ?? "")}</td>
      </tr>`,
    )
    .join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Applications</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}
  main{max-width:1000px;margin:0 auto;padding:16px}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th,td{border-top:1px solid #e7e5e4;padding:8px 10px;text-align:left;font-size:.9rem;vertical-align:top}
  th{background:#fafaf9}
</style></head><body><main>
  <h1>Submitted applications (${rows.length})</h1>
  <table><tr><th>Submitted</th><th>Company</th><th>Role</th><th>Fit</th><th>Materials</th><th>Confirmation</th></tr>${table}</table>
</main></body></html>`);
});

// --- material editing: manual saves and AI-directed revisions ---
const backToReview = (res: express.Response, jobId: string) =>
  res.redirect(`${baseUrl()}/review/${jobId}`);

app.post("/review/:jobId/letter", (req, res) => {
  const jobId = req.params.jobId;
  const application = applications.get(jobId);
  const text = String((req.body as { text?: string }).text ?? "").trim();
  if (!application || text.length < 100) {
    res.status(400).send("Letter missing or too short; nothing saved.");
    return;
  }
  writeFileSync(application.coverLetterPath, text);
  applications.save({ ...application, coverLetterText: text });
  events.log({ jobId, kind: "letter_edited", data: { by: "human" } });
  backToReview(res, jobId);
});

app.post("/review/:jobId/letter/revise", async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  const application = applications.get(jobId);
  const instruction = String((req.body as { instruction?: string }).instruction ?? "").trim();
  if (!job || !application || !instruction) {
    res.status(400).send("Missing job, application, or instruction.");
    return;
  }
  try {
    const profile = JSON.parse(readFileSync(resolve(process.cwd(), "config/profile.json"), "utf8"));
    const rendered = RenderedResume.parse(
      JSON.parse(readFileSync(application.resumeJsonPath, "utf8")),
    );
    const letter = await reviseCoverLetter(
      job, rendered, application.coverLetterText, instruction, profile.voice.sample,
    );
    applications.save({ ...application, coverLetterText: letter.text, coverLetterPath: letter.path });
    events.log({ jobId, kind: "letter_revised", data: { instruction } });
    backToReview(res, jobId);
  } catch (err) {
    res.status(500).send(`Revision failed: ${esc(String(err).slice(0, 300))}. <a href="${baseUrl()}/review/${jobId}">back</a>`);
  }
});

app.post("/review/:jobId/resume/revise", async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  const application = applications.get(jobId);
  const score = scores.get(jobId);
  const instruction = String((req.body as { instruction?: string }).instruction ?? "").trim();
  if (!job || !application || !score || !instruction) {
    res.status(400).send("Missing job, application, score, or instruction.");
    return;
  }
  try {
    const profile = JSON.parse(readFileSync(resolve(process.cwd(), "config/profile.json"), "utf8"));
    const variants = loadVariants();
    const variant = getVariant(variants, application.variantId);
    const rendered = await tailorResume(job, variant, score, undefined, instruction);
    const { pdfPath, jsonPath } = await renderResumePdf(
      rendered,
      resumeIdentityFromProfile(profile.identity),
      jobId,
    );
    applications.save({ ...application, resumePath: pdfPath, resumeJsonPath: jsonPath });
    events.log({ jobId, kind: "resume_revised", data: { instruction } });
    backToReview(res, jobId);
  } catch (err) {
    res.status(500).send(`Re-tailor failed: ${esc(String(err).slice(0, 300))}. <a href="${baseUrl()}/review/${jobId}">back</a>`);
  }
});

// --- approval webhooks (one-click links from the notification) ---
app.get("/approval/:id/:decision", (req, res) => {
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).send("bad decision");
    return;
  }
  const result = resolveApproval(req.params.id, decision);
  if (!result) {
    res.status(410).send("This approval link is invalid or already used.");
    return;
  }
  res.send(
    `<h2>${decision === "approve" ? "Approved" : "Rejected"}</h2>` +
      `<p>Job ${result.jobId} marked <b>${decision}d</b>. ` +
      (decision === "approve" ? "It will be submitted on the next submit run." : "It will not be submitted.") +
      `</p>`,
  );
});

// n8n can also POST a structured decision (e.g. from a Slack action) with a note.
app.post("/approval/:id", requireSecret, (req, res) => {
  const { decision, note } = req.body as { decision: "approve" | "reject" | "edit"; note?: string };
  const result = resolveApproval(String(req.params.id), decision, note);
  if (!result) {
    res.status(410).json({ error: "invalid or already-decided" });
    return;
  }
  res.json({ ok: true, jobId: result.jobId, decision });
});

app.listen(config.env.port, () => {
  console.log(`auto-apply-bot server on ${baseUrl()} (DRY_RUN=${config.env.dryRun})`);
});
