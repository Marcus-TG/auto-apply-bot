/**
 * Repositories: the ONLY place that knows SQL. Everything else speaks in domain
 * types. If you migrate to Postgres, this file is the blast radius.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import type {
  JobPosting,
  JobStatus,
  FitScore,
  TailoredApplication,
  ApprovalLane,
  ApprovalDecision,
  PipelineEvent,
} from "../types/index.js";

const now = () => new Date().toISOString();

// ---------- jobs ----------
export const jobs = {
  upsert(job: JobPosting): void {
    db()
      .prepare(
        `INSERT INTO jobs (id, source, ats, company, title, location, remote, url, apply_url,
            description, compensation, posted_at, discovered_at, status, raw, updated_at)
         VALUES (@id,@source,@ats,@company,@title,@location,@remote,@url,@applyUrl,
            @description,@compensation,@postedAt,@discoveredAt,'discovered',@raw,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET
            description=excluded.description, url=excluded.url, apply_url=excluded.apply_url,
            compensation=excluded.compensation, updated_at=excluded.updated_at`,
      )
      .run({
        ...job,
        compensation: job.compensation ? JSON.stringify(job.compensation) : null,
        raw: JSON.stringify(job.raw),
        updatedAt: now(),
      });
  },

  setStatus(id: string, status: JobStatus): void {
    db()
      .prepare(`UPDATE jobs SET status=?, updated_at=? WHERE id=?`)
      .run(status, now(), id);
  },

  get(id: string): (JobPosting & { status: JobStatus }) | undefined {
    const row = db().prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : undefined;
  },

  byStatus(status: JobStatus): (JobPosting & { status: JobStatus })[] {
    return (db().prepare(`SELECT * FROM jobs WHERE status=?`).all(status) as Record<
      string,
      unknown
    >[]).map(rowToJob);
  },

  exists(id: string): boolean {
    return !!db().prepare(`SELECT 1 FROM jobs WHERE id=?`).get(id);
  },
};

function rowToJob(r: Record<string, unknown>): JobPosting & { status: JobStatus } {
  return {
    id: r.id as string,
    source: r.source as JobPosting["source"],
    ats: (r.ats as string) ?? null,
    company: r.company as string,
    title: r.title as string,
    location: (r.location as string) ?? null,
    remote: r.remote as JobPosting["remote"],
    url: r.url as string,
    applyUrl: (r.apply_url as string) ?? null,
    description: r.description as string,
    compensation: r.compensation ? JSON.parse(r.compensation as string) : null,
    postedAt: (r.posted_at as string) ?? null,
    discoveredAt: r.discovered_at as string,
    raw: JSON.parse((r.raw as string) ?? "{}"),
    status: r.status as JobStatus,
  };
}

// ---------- scores ----------
export const scores = {
  save(score: FitScore, lane: ApprovalLane): void {
    db()
      .prepare(
        `INSERT OR REPLACE INTO scores
          (job_id, overall, confidence, dimensions, recommended_variant, summary,
           matched_keywords, gap_keywords, lane, model, scored_at)
         VALUES (@jobId,@overall,@confidence,@dimensions,@recommendedVariant,@summary,
           @matched,@gap,@lane,@model,@scoredAt)`,
      )
      .run({
        jobId: score.jobId,
        overall: score.overall,
        confidence: score.confidence,
        dimensions: JSON.stringify(score.dimensions),
        recommendedVariant: score.recommendedVariant,
        summary: score.summary,
        matched: JSON.stringify(score.matchedKeywords),
        gap: JSON.stringify(score.gapKeywords),
        lane,
        model: score.model,
        scoredAt: score.scoredAt,
      });
  },
  get(jobId: string): (FitScore & { lane: ApprovalLane }) | undefined {
    const r = db().prepare(`SELECT * FROM scores WHERE job_id=?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      jobId: r.job_id as string,
      overall: r.overall as number,
      confidence: r.confidence as number,
      dimensions: JSON.parse(r.dimensions as string),
      recommendedVariant: r.recommended_variant as string,
      summary: r.summary as string,
      matchedKeywords: JSON.parse(r.matched_keywords as string),
      gapKeywords: JSON.parse(r.gap_keywords as string),
      lane: r.lane as ApprovalLane,
      model: r.model as string,
      scoredAt: r.scored_at as string,
    };
  },
};

// ---------- applications ----------
export const applications = {
  save(app: TailoredApplication): void {
    db()
      .prepare(
        `INSERT OR REPLACE INTO applications
          (job_id, variant_id, resume_path, resume_json_path, cover_letter_path, cover_letter_text, created_at)
         VALUES (@jobId,@variantId,@resumePath,@resumeJsonPath,@coverLetterPath,@coverLetterText,@createdAt)`,
      )
      .run(app);
  },
  get(jobId: string): TailoredApplication | undefined {
    const r = db().prepare(`SELECT * FROM applications WHERE job_id=?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      jobId: r.job_id as string,
      variantId: r.variant_id as string,
      resumePath: r.resume_path as string,
      resumeJsonPath: r.resume_json_path as string,
      coverLetterPath: r.cover_letter_path as string,
      coverLetterText: r.cover_letter_text as string,
      createdAt: r.created_at as string,
    };
  },
};

// ---------- approvals ----------
export const approvals = {
  create(jobId: string, expiresAt: string): string {
    const id = randomUUID();
    db()
      .prepare(
        `INSERT INTO approvals (id, job_id, requested_at, expires_at) VALUES (?,?,?,?)`,
      )
      .run(id, jobId, now(), expiresAt);
    return id;
  },
  resolve(id: string, decision: ApprovalDecision, note?: string): string | undefined {
    const row = db().prepare(`SELECT job_id, decision FROM approvals WHERE id=?`).get(id) as
      | { job_id: string; decision: string | null }
      | undefined;
    if (!row || row.decision) return undefined; // unknown or already decided (idempotent)
    db()
      .prepare(`UPDATE approvals SET decision=?, decided_at=?, note=? WHERE id=?`)
      .run(decision, now(), note ?? null, id);
    return row.job_id;
  },
  /** The not-yet-decided approval for a job, if any (newest first). */
  pendingForJob(jobId: string): { id: string; expires_at: string } | undefined {
    return db()
      .prepare(
        `SELECT id, expires_at FROM approvals WHERE job_id=? AND decision IS NULL ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(jobId) as { id: string; expires_at: string } | undefined;
  },
  expirePending(): { id: string; job_id: string }[] {
    const rows = db()
      .prepare(
        `SELECT id, job_id FROM approvals WHERE decision IS NULL AND expires_at < ?`,
      )
      .all(now()) as { id: string; job_id: string }[];
    for (const r of rows) {
      db().prepare(`UPDATE approvals SET decision='timeout', decided_at=? WHERE id=?`).run(now(), r.id);
    }
    return rows;
  },
};

// ---------- events (audit) ----------
export const events = {
  log(e: Omit<PipelineEvent, "at"> & { at?: string }): void {
    db()
      .prepare(`INSERT INTO events (job_id, kind, at, data) VALUES (?,?,?,?)`)
      .run(e.jobId ?? null, e.kind, e.at ?? now(), JSON.stringify(e.data ?? {}));
  },
};

// ---------- submissions (rate limit + idempotency) ----------
export const submissions = {
  record(jobId: string, confirmation: string | null): void {
    db()
      .prepare(`INSERT OR IGNORE INTO submissions (job_id, submitted_at, confirmation) VALUES (?,?,?)`)
      .run(jobId, now(), confirmation);
  },
  countLast24h(): number {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = db()
      .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE submitted_at >= ?`)
      .get(since) as { n: number };
    return r.n;
  },
  has(jobId: string): boolean {
    return !!db().prepare(`SELECT 1 FROM submissions WHERE job_id=?`).get(jobId);
  },
  all(): { job_id: string; submitted_at: string; confirmation: string | null }[] {
    return db()
      .prepare(`SELECT job_id, submitted_at, confirmation FROM submissions ORDER BY submitted_at DESC`)
      .all() as { job_id: string; submitted_at: string; confirmation: string | null }[];
  },
};
