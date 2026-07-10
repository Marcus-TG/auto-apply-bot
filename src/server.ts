/**
 * HTTP surface that n8n drives. Two kinds of endpoints:
 *   - Pipeline triggers (/run/*) — n8n's cron workflow calls these on a schedule.
 *   - Approval webhooks (/approval/*) — the Approve/Reject links in the review
 *     notification point here; n8n can also POST decisions to /approval/:id.
 *
 * Auth is a shared secret header (x-webhook-secret) for the trigger routes; the
 * approval GET links are unguessable UUIDs so they work as one-click email links.
 */
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { config } from "./config/index.js";
import { initSchema } from "./store/db.js";
import { jobs, scores, applications, approvals, submissions } from "./store/repositories.js";
import {
  discover,
  scoreNewJobs,
  tailorScoredJobs,
  submitApproved,
  runPipeline,
} from "./orchestrator/pipeline.js";
import { resolveApproval, sweepExpiredApprovals } from "./approval/index.js";

initSchema();
const app = express();
app.use(express.json({ limit: "1mb" }));

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
    ? `<a class="btn ok" href="${baseUrl()}/approval/${approval.id}/approve">✅ Approve &amp; submit</a>
       <a class="btn no" href="${baseUrl()}/approval/${approval.id}/reject">❌ Reject</a>
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
  <div class="card"><h2>Cover letter</h2><pre>${esc(application.coverLetterText)}</pre></div>
  <div class="card"><h2>Resume (as submitted)</h2>
    <iframe src="${baseUrl()}/artifacts/${jobId}/resume.pdf"></iframe>
    <p class="muted"><a href="${baseUrl()}/artifacts/${jobId}/resume.pdf">open PDF directly</a></p>
  </div>
</main></body></html>`);
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
    `<h2>${decision === "approve" ? "✅ Approved" : "❌ Rejected"}</h2>` +
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
