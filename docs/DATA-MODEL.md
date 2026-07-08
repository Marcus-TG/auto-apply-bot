# Data model

SQLite (`DATABASE_PATH`, default `./data/app.sqlite`). Single-user, embedded,
zero-ops. All SQL is confined to `src/store/repositories.ts`; port that file to
move to Postgres. Schema in `src/store/schema.sql`.

## Tables

- **jobs** — one row per discovered posting. `id` is the dedupe hash of
  (source, company, title, location). `status` is the pipeline state machine
  (`discovered → scored → tailoring → awaiting_approval → approved → submitting →
  submitted`, plus `prefiltered_out`, `rejected`, `needs_human`, `failed`, `skipped`).
- **scores** — the fit assessment per job: `overall`, `confidence`, the per-dimension
  JSON, `recommended_variant`, `matched_keywords`, `gap_keywords`, and the assigned
  `lane`.
- **applications** — the tailored artifacts per job: resume PDF path, structured
  resume JSON path, cover-letter path + text, chosen `variant_id`.
- **approvals** — the human review queue. UUID `id` doubles as the token in the
  approve/reject URL. `decision` null = pending. Resolved by a click, an n8n POST,
  or the timeout sweep.
- **events** — append-only audit log. Every decision and action lands here
  (`discovered`, `scored`, `tailored`, `approval_requested`, `captcha_detected`,
  `submitted`, `submit_error`, …). This is your debugging and "why did it do that"
  trail, and the raw material for a future learning loop.
- **submissions** — one row per real submission; powers idempotency (never submit
  twice) and the daily rate limit.

## Artifacts on disk

Generated files live under `ARTIFACTS_DIR/<jobId>/`:

```
artifacts/<jobId>/
  resume.json      structured RenderedResume that produced the PDF
  resume.html      the intermediate (for debugging layout)
  resume.pdf       the ATS-parseable PDF that gets uploaded
  cover-letter.txt
  presubmit.png    screenshot taken right before submit (audit)
```

Keeping the structured `resume.json` next to the PDF means you can re-render or edit
any past application without re-running the LLM.

## Resume as structured data

A resume is **not** a blob (see `src/resume/model.ts`). Each variant holds
experiences with a `bulletPool` of pre-approved, tagged bullets. Tailoring selects
bullet **ids**; rendering emits their exact approved text. This is what makes
fabrication structurally impossible — the model never authors resume content.
