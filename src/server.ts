/**
 * HTTP surface that n8n drives. Two kinds of endpoints:
 *   - Pipeline triggers (/run/*) — n8n's cron workflow calls these on a schedule.
 *   - Approval webhooks (/approval/*) — the Approve/Reject links in the review
 *     notification point here; n8n can also POST decisions to /approval/:id.
 *
 * Auth is a shared secret header (x-webhook-secret) for the trigger routes; the
 * approval GET links are unguessable UUIDs so they work as one-click email links.
 */
import express from "express";
import { config } from "./config/index.js";
import { initSchema } from "./store/db.js";
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
