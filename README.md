# auto-apply-bot

AI-powered job search agent: discovers postings, scores fit with Claude, tailors a
resume + cover letter per role, gates high-fit jobs for your review, and submits
applications through a browser — with safety rails throughout.

```
discover → dedupe → prefilter → LLM fit-score → tailor → gate (auto|human) → submit → audit
```

## What it does

- **Discovers** jobs from ATS-direct JSON APIs (Greenhouse, Lever, Ashby, Workday).
  LinkedIn/Indeed adapters exist but ship as ToS-gated stubs — see
  [docs/TOS-AND-SAFETY.md](docs/TOS-AND-SAFETY.md).
- **Scores fit** in two stages: a free deterministic prefilter, then a Claude rubric
  score (prompt-cached profile, structured JSON output). See [docs/SCORING.md](docs/SCORING.md).
- **Tailors honestly**: picks the best of your resume variants and selects from a
  *pre-approved* bullet bank by id — the model never writes new resume claims. Cover
  letters are grounded in the JD + your real content + your voice sample.
- **Gates** high-fit roles for your approval (email/Telegram/Slack via n8n) before
  anything is submitted. See [docs/APPROVAL-FLOW.md](docs/APPROVAL-FLOW.md).
- **Submits** via a swappable browser backend, pausing for CAPTCHAs and unknown
  fields instead of guessing. See [docs/EDGE-CASES.md](docs/EDGE-CASES.md).

## Stack

TypeScript worker (adapters, scoring, tailoring, browser) + n8n (scheduling,
approval delivery/wait) + SQLite (state & audit) + Claude API. Browser automation
runs on **local Chromium**, **self-hosted Kernel** (`kernel-images`, Apache-2.0), or
**Kernel cloud** — one env var switches them. See [docs/KERNEL-SELF-HOST.md](docs/KERNEL-SELF-HOST.md).

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env                                  # pick your LLM provider (below)
cp config/profile.example.json config/profile.json    # fill in your details
cp config/sources.example.json config/sources.json    # companies to poll
npm run db:init
npm run pipeline        # runs discover → score → tailor → (submit; DRY_RUN by default)
```

### Bring your own LLM

Model ids route by prefix — mix providers per stage via `MODEL_PREFILTER` /
`MODEL_GENERATION` in `.env`:

| Model id | Provider | Cost |
|---|---|---|
| `claude-sonnet-5`, `claude-haiku-...` | Anthropic API (`ANTHROPIC_API_KEY`) | API billing |
| `claude-cli:sonnet` | Your logged-in Claude Code CLI (headless) | Claude subscription usage |
| `ollama:qwen3-coder:30b`, `local:...` | Any OpenAI-compatible endpoint (`LOCAL_LLM_BASE_URL`) | free/local |

A good split: high-volume fit-scoring on a local model, generation on a strong
hosted model.

Nothing submits until you set `DRY_RUN=false`, and high-fit jobs always wait for
your approval. Full walkthrough: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Safety defaults

`DRY_RUN=true`, `autoApplyEnabled=false`, LinkedIn/Indeed off, 15 submissions/day
cap, CAPTCHAs handed to you. Turn these up deliberately as you build trust. Rationale
in [docs/TOS-AND-SAFETY.md](docs/TOS-AND-SAFETY.md).

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape, module map, principles |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Tables, artifacts, structured resume |
| [SCORING.md](docs/SCORING.md) | Prefilter + rubric + cost controls |
| [APPROVAL-FLOW.md](docs/APPROVAL-FLOW.md) | Lanes, the gate, timeouts |
| [EDGE-CASES.md](docs/EDGE-CASES.md) | Missing fields, CAPTCHAs, site variation |
| [KERNEL-SELF-HOST.md](docs/KERNEL-SELF-HOST.md) | Browser backend options |
| [TOS-AND-SAFETY.md](docs/TOS-AND-SAFETY.md) | Source posture & safe operation |
| [RUNBOOK.md](docs/RUNBOOK.md) | Setup, running, rollout order |

## Where to customize

- **Sources**: `config/sources.json` (board tokens per company).
- **Your profile**: `config/profile.json`.
- **Resume variants**: `config/resume-variants/*.json` (structured, with a bullet bank).
- **Thresholds/weights**: `config/thresholds.json`.
- **New job board**: add an adapter in `src/discovery/` + register it — nothing else changes.
