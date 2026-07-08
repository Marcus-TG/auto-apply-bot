# Architecture

## The pipeline

```
discover → normalize/dedupe → prefilter → LLM fit-score → assign lane
   → tailor (resume + cover letter) → gate (auto | human review)
   → submit (browser) → track → audit log
```

Each stage is an independently runnable function in `src/orchestrator/pipeline.ts`.
You can re-drive any single stage (e.g. re-score, re-tailor) without redoing the
others. State lives in SQLite; the job's `status` column is the state machine.

## Orchestration split: n8n vs. the worker

**Rule of thumb: glue in n8n, logic in code.**

- **n8n** owns scheduling (cron), the human-approval *wait*, and notification
  delivery (email/Telegram/Slack). It calls the worker over HTTP.
- **The TypeScript worker** (`src/`) owns everything with real logic: adapters,
  scoring, tailoring, browser automation. It exposes HTTP endpoints (`src/server.ts`)
  that n8n triggers, and a CLI (`src/cli.ts`) so you can run it without n8n at all.

This keeps the LLM/browser complexity in testable code instead of a sprawl of n8n
nodes, while still getting n8n's scheduling and approval-wait for free.

## Modules

| Module | Responsibility |
|---|---|
| `discovery/` | One adapter per source → normalized `JobPosting`. Registry in `index.ts`. |
| `normalize/` | Dedupe keys, remote classification. |
| `scoring/` | `prefilter` (free hard filters) → `llm-scorer` (rubric) → `assignLane`. |
| `resume/` | Structured resume model, variant selection, honest tailoring, PDF render. |
| `coverletter/` | Grounded, voice-matched generation with a self-critique pass. |
| `apply/` | `BrowserProvider` abstraction + ATS fillers + CAPTCHA handoff + rate limit. |
| `approval/` | Review request/resolve state; n8n handles delivery. |
| `store/` | SQLite schema + repositories (the only place with SQL). |
| `llm/` | Anthropic wrapper: prompt caching + tool-use structured output. |
| `orchestrator/` | The pipeline that walks jobs through the state machine. |

## Design principles

1. **Honesty by construction.** The tailor selects from a pre-approved bullet bank
   by id and emits the exact approved text — it cannot write new claims. Scores
   separate `matchedKeywords` (supported) from `gapKeywords` (never to be implied).
2. **Fail safe, never blind-submit.** Unknown required fields, CAPTCHAs, and login
   walls park the job in `needs_human` with a live-view URL. `DRY_RUN` (default on)
   fills forms but never clicks submit.
3. **Cost control.** Two-stage scoring (free prefilter, then LLM), prompt-cached
   profile/rubric, cheap model for volume + strong model for finalists/generation.
4. **Swappable browser backend.** `local` / `kernel-selfhost` / `kernel-cloud` behind
   one interface; flip an env var. See [KERNEL-SELF-HOST.md](./KERNEL-SELF-HOST.md).
5. **Everything audited.** Every decision writes to the `events` table.

See also: [DATA-MODEL.md](./DATA-MODEL.md), [SCORING.md](./SCORING.md),
[APPROVAL-FLOW.md](./APPROVAL-FLOW.md), [EDGE-CASES.md](./EDGE-CASES.md),
[TOS-AND-SAFETY.md](./TOS-AND-SAFETY.md), [RUNBOOK.md](./RUNBOOK.md).
