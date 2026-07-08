/**
 * Notification dispatch. Primary path is n8n (POST the ApprovalCard to a webhook;
 * n8n formats + delivers to email/Telegram/Slack and shows the Approve/Reject
 * buttons). This helper is the fallback / direct trigger when you'd rather push
 * from the worker than pull from n8n.
 */
import { config } from "../config/index.js";
import type { ApprovalCard } from "./index.js";

export async function notifyN8n(card: ApprovalCard): Promise<void> {
  if (!config.env.n8nApprovalWebhook) return;
  await fetch(config.env.n8nApprovalWebhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": config.env.webhookSecret,
    },
    body: JSON.stringify(card),
  }).catch(() => {
    // Non-fatal: the request stays pending in the DB and can be re-notified.
  });
}
