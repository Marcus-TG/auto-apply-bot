-- SQLite schema. Single-user, embedded, zero-ops. Swap for Postgres by porting
-- these DDL statements if you outgrow it (the repositories layer is the only
-- other thing that would change).

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,          -- dedupe hash
  source        TEXT NOT NULL,
  ats           TEXT,
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT,
  remote        TEXT NOT NULL DEFAULT 'unknown',
  url           TEXT NOT NULL,
  apply_url     TEXT,
  description   TEXT NOT NULL,
  compensation  TEXT,                      -- JSON
  posted_at     TEXT,
  discovered_at TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'discovered',
  raw           TEXT NOT NULL DEFAULT '{}',-- JSON
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS scores (
  job_id             TEXT PRIMARY KEY REFERENCES jobs(id),
  overall            REAL NOT NULL,
  confidence         REAL NOT NULL,
  dimensions         TEXT NOT NULL,        -- JSON array
  recommended_variant TEXT NOT NULL,
  summary            TEXT NOT NULL,
  matched_keywords   TEXT NOT NULL,        -- JSON array
  gap_keywords       TEXT NOT NULL,        -- JSON array
  lane               TEXT NOT NULL,        -- reject | auto | review
  model              TEXT NOT NULL,
  scored_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(id),
  variant_id        TEXT NOT NULL,
  resume_path       TEXT NOT NULL,
  resume_json_path  TEXT NOT NULL,
  cover_letter_path TEXT NOT NULL,
  cover_letter_text TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- Human approval queue. One row per review request; resolved when the human
-- (or the timeout) sets `decision`.
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,           -- also the token in the approve/reject URL
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  requested_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  decision     TEXT,                       -- approve | reject | edit | timeout (null = pending)
  decided_at   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(decision) WHERE decision IS NULL;

-- Append-only audit log. Every decision and action lands here.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT,
  kind    TEXT NOT NULL,
  at      TEXT NOT NULL,
  data    TEXT NOT NULL DEFAULT '{}'       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

-- Records every real submission for the daily rate-limit + idempotency checks.
CREATE TABLE IF NOT EXISTS submissions (
  job_id        TEXT PRIMARY KEY REFERENCES jobs(id),
  submitted_at  TEXT NOT NULL,
  confirmation  TEXT
);
