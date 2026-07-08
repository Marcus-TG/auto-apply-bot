# Runbook

## First-time setup

```bash
npm install
npx playwright install chromium      # browser for PDF render + local apply
cp .env.example .env                  # then set ANTHROPIC_API_KEY, WEBHOOK_SECRET
cp config/profile.example.json config/profile.json   # then fill in your real details
cp config/sources.example.json config/sources.json   # then set your company board tokens
# add your real resume variants under config/resume-variants/*.json
npm run db:init
```

## Running

Two ways — they call the same pipeline functions.

### A) By hand / cron (no n8n)
```bash
npm run discover        # pull postings
tsx src/cli.ts score    # prefilter + LLM score
tsx src/cli.ts tailor   # tailor + queue approvals
tsx src/cli.ts submit   # submit approved jobs
# or the whole non-human loop:
npm run pipeline
```

### B) Server + n8n
```bash
npm run server          # exposes /run/* and /approval/* on PORT
```
Import `n8n/workflows/*.json` into n8n, set the `x-webhook-secret` header and the
worker base URL in the HTTP nodes. The discovery workflow hits `/run/discover`,
`/run/score`, `/run/tailor` on a schedule; the approval workflow delivers the review
card and waits for your click.

## Safe rollout order

1. `DRY_RUN=true` (default). Run the full loop; inspect `artifacts/<jobId>/` — check
   the resumes/cover letters read well and forms fill correctly (screenshots).
2. Switch `BROWSER_PROVIDER=kernel-selfhost` and watch a run via the live view.
3. Set `DRY_RUN=false` for real submission on ATS-direct sources you trust.
4. Only then consider raising `MAX_SUBMISSIONS_PER_DAY` or enabling `autoApplyEnabled`.

## Common operations

- **See why a job was rejected/parked:** query the `events` table for its `job_id`.
- **Re-tailor one job:** set its `status` back to `scored` and run `tailor`.
- **Finish a `needs_human` job:** open its apply URL (or live-view URL from the event
  log) and complete it manually.
- **Clear a stuck approval:** `POST /run/sweep` times out anything past expiry.

## Health
```bash
curl localhost:8787/health      # { ok: true, dryRun: true }
```
