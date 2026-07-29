/**
 * Track record: what the market actually did with the applications we sent.
 *
 * The hire-odds refiner used to reason purely from the posting text, so it had
 * no way to notice that its own high scores kept bouncing. Observed outcomes
 * are the only real feedback in this system, and they were being thrown away:
 * senior engineering roles scored 68 and were rejected in 1-2 days, while local
 * IT roles it scored 45 were never tried at all.
 *
 * This summarizes outcomes into evidence the refiner can weigh. It stays
 * descriptive on purpose — it reports what happened rather than prescribing a
 * penalty — because the sample is small and a hard rule learned from ~34
 * applications would overfit badly.
 */
import { db } from "../store/db.js";
import { laneFor } from "./lanes.js";

/** Fast rejections mean a screen, not a considered decision. */
const FAST_REJECT_DAYS = 3;

export interface OutcomeBucket {
  bucket: string;
  sent: number;
  rejected: number;
  fastRejected: number;
  interviews: number;
  silent: number;
  medianDaysToReject: number | null;
}

interface Row {
  title: string;
  company: string;
  location: string | null;
  remote: string;
  submitted_at: string;
  status: string | null;
  updated_at: string | null;
}

const SENIOR = /\b(senior|staff|principal|lead|director|head of|manager|sr\.?)\b/i;
const ENGINEERING = /\b(engineer|developer|architect|scientist|programmer)\b/i;

/** Coarse buckets: enough signal to be useful, few enough to stay readable. */
export function bucketOf(job: { title: string; location: string | null }): string {
  const lane = laneFor(job);
  if (lane) return lane.label;
  if (SENIOR.test(job.title)) return "Senior/Staff+ roles";
  if (ENGINEERING.test(job.title)) return "Mid-level engineering/AI roles";
  return "Other roles";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export function outcomeBuckets(): OutcomeBucket[] {
  const rows = db()
    .prepare(
      `SELECT j.title, j.company, j.location, j.remote, s.submitted_at, f.status, f.updated_at
         FROM submissions s
         JOIN jobs j ON j.id = s.job_id
         LEFT JOIN followups f ON f.job_id = s.job_id`,
    )
    .all() as unknown as Row[];

  const byBucket = new Map<string, { rows: Row[]; days: number[] }>();
  for (const r of rows) {
    const b = bucketOf(r);
    const e = byBucket.get(b) ?? { rows: [], days: [] };
    e.rows.push(r);
    if (r.status === "rejected" && r.updated_at) {
      const d = Math.round(
        (Date.parse(r.updated_at) - Date.parse(r.submitted_at)) / 86_400_000,
      );
      if (Number.isFinite(d) && d >= 0) e.days.push(d);
    }
    byBucket.set(b, e);
  }

  return [...byBucket.entries()]
    .map(([bucket, e]) => ({
      bucket,
      sent: e.rows.length,
      rejected: e.rows.filter((r) => r.status === "rejected").length,
      fastRejected: e.days.filter((d) => d <= FAST_REJECT_DAYS).length,
      interviews: e.rows.filter((r) => r.status && ["screening", "interview", "offer"].includes(r.status)).length,
      silent: e.rows.filter((r) => !r.status || r.status === "applied" || r.status === "no_response").length,
      medianDaysToReject: median(e.days),
    }))
    .sort((a, b) => b.sent - a.sent);
}

/**
 * The track record as prompt text, or null when there isn't enough of one to
 * be worth conditioning on. Below this threshold the honest move is to say
 * nothing rather than let the model over-read two data points.
 */
export function trackRecordBlock(minSent = 5): string | null {
  const buckets = outcomeBuckets();
  const total = buckets.reduce((n, b) => n + b.sent, 0);
  if (total < minSent) return null;

  const lines = buckets.map((b) => {
    const parts = [`sent ${b.sent}`, `rejected ${b.rejected}`];
    if (b.fastRejected) parts.push(`${b.fastRejected} of those within ${FAST_REJECT_DAYS} days`);
    if (b.medianDaysToReject !== null) parts.push(`median ${b.medianDaysToReject}d to rejection`);
    parts.push(`${b.interviews} reached a screen or interview`);
    parts.push(`${b.silent} no reply yet`);
    return `- ${b.bucket}: ${parts.join(", ")}`;
  });

  // Rank buckets against each other so the model has a comparative frame. A flat
  // "no interviews anywhere" reading makes it score everything at the floor,
  // which is exactly as useless for ranking as scoring everything high.
  const tested = buckets.filter((b) => b.sent >= 3);
  const worst = [...tested].sort(
    (a, b) => b.fastRejected / b.sent - a.fastRejected / a.sent,
  )[0];

  return `Observed outcomes for applications this candidate has ALREADY sent (${total} total):
${lines.join("\n")}

How to use this. It is evidence for RANKING postings against each other, not a
verdict on the search. Specifically:

- Zero interviews across the board is normal at this sample size and this early
  in a search. It is NOT evidence that every posting is hopeless, and it must not
  drag every score down to the floor. You still have to spread scores out.
- Compare buckets to EACH OTHER. ${
    worst
      ? `"${worst.bucket}" currently has the highest share of rejections inside ${FAST_REJECT_DAYS} days, so postings like it should rank BELOW otherwise-comparable postings from other buckets.`
      : `No bucket yet has enough sends to stand out.`
  }
- A rejection inside ${FAST_REJECT_DAYS} days means the application was screened out before a
  human weighed it, which is a signal about target selection, not about the
  candidate's materials.
- A bucket with few or no sends is UNTESTED, not proven bad. Never penalize a
  posting because its category lacks data; judge those on the posting itself.`;
}
