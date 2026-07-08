/**
 * Approval gate. Creates a review request, hands n8n a summary payload + approve/
 * reject URLs, and resolves decisions coming back from n8n webhooks.
 *
 * n8n owns delivery (email/Telegram/Slack) and the human-facing "wait" — this
 * module owns the state. The two approve/reject links point at THIS server's
 * /approval/:id/:decision endpoints (see src/server.ts).
 */
import { config } from "../config/index.js";
import { approvals, scores, applications, jobs, events } from "../store/repositories.js";
import type { JobPosting } from "../types/index.js";

export interface ApprovalCard {
  approvalId: string;
  job: { id: string; title: string; company: string; url: string };
  score: { overall: number; confidence: number; summary: string };
  matched: string[];
  gaps: string[];
  resumePath: string;
  coverLetterText: string;
  approveUrl: string;
  rejectUrl: string;
  expiresAt: string;
}

/** Create the approval request and return the card n8n will render/send. */
export function requestApproval(job: JobPosting, baseUrl: string): ApprovalCard {
  const score = scores.get(job.id);
  const app = applications.get(job.id);
  if (!score || !app) throw new Error(`Cannot request approval for ${job.id}: missing score/application`);

  const expiresAt = new Date(
    Date.now() + config.thresholds.approvalTimeoutHours * 3600_000,
  ).toISOString();
  const id = approvals.create(job.id, expiresAt);
  jobs.setStatus(job.id, "awaiting_approval");
  events.log({ jobId: job.id, kind: "approval_requested", data: { approvalId: id } });

  return {
    approvalId: id,
    job: { id: job.id, title: job.title, company: job.company, url: job.url },
    score: { overall: score.overall, confidence: score.confidence, summary: score.summary },
    matched: score.matchedKeywords,
    gaps: score.gapKeywords,
    resumePath: app.resumePath,
    coverLetterText: app.coverLetterText,
    approveUrl: `${baseUrl}/approval/${id}/approve`,
    rejectUrl: `${baseUrl}/approval/${id}/reject`,
    expiresAt,
  };
}

/** Resolve a decision (called from the webhook route). Returns the affected jobId. */
export function resolveApproval(
  id: string,
  decision: "approve" | "reject" | "edit",
  note?: string,
): { jobId: string } | null {
  const jobId = approvals.resolve(id, decision, note);
  if (!jobId) return null; // unknown or already decided
  jobs.setStatus(jobId, decision === "approve" ? "approved" : "rejected");
  events.log({ jobId, kind: `approval_${decision}`, data: { approvalId: id, note } });
  return { jobId };
}

/** Sweep expired approvals → mark their jobs rejected (timed out). Called on a timer/cron. */
export function sweepExpiredApprovals(): number {
  const expired = approvals.expirePending();
  for (const { job_id } of expired) {
    jobs.setStatus(job_id, "rejected");
    events.log({ jobId: job_id, kind: "approval_timeout", data: {} });
  }
  return expired.length;
}
