# Strauss AI content pipeline

Generator → evaluator loop (generate → score against rubric → retry with
critique → queue) producing blog posts for straussai.ca and LinkedIn posts,
in two lanes:

- **Case studies** — drafted ONLY from a completed `facts/<slug>.yaml`.
  Never invents client specifics. Always require manual approval.
- **Educational** — small-business AI topics from `topics.yaml`, may use web
  search during generation.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

The default engine backend is `claude-cli` (runs through the local `claude`
CLI on the subscription, no API key). For unattended runs, set
`engine.backend: api` in `config.yaml` and export `ANTHROPIC_API_KEY`.

## Commands

```sh
.venv/bin/python -m pipeline generate --lane educational --platform linkedin --count 3
.venv/bin/python -m pipeline generate --lane case-study --platform blog --facts ai-policy-assistant
.venv/bin/python -m pipeline list [--status passed]
.venv/bin/python -m pipeline show <id>
.venv/bin/python -m pipeline evaluate <id>          # re-run rubric after hand edits
.venv/bin/python -m pipeline approve <id>
.venv/bin/python -m pipeline schedule <id> 2026-07-15T09:00
.venv/bin/python -m pipeline reject <id>
```

## How it works

1. `generate` builds a prompt from `pipeline/voice.md` + the platform spec +
   (topic | facts file) and drafts via the engine backend.
2. Mechanical checks run first, in code (`pipeline/checks.py`): em dashes,
   banned words (`rubric.yaml`), platform format/length.
3. If those pass, a fresh-context LLM judge scores the judged checks (voice,
   invented facts, one takeaway). The judge sees only the draft, the rubric,
   and the facts file — never the generation conversation.
4. Failures are fed back verbatim and the generator retries, up to
   `engine.max_attempts`. Every attempt's report lands in `evals/<id>.json`.
5. The item lands in `queue/<id>.md` with status `passed` or `failed`.

## Queue lifecycle

```
draft → passed ── (educational LinkedIn) ────────────→ scheduled → published
   │        └──── (case study OR blog) → approved ───→ scheduled → published
   └─ 3 fails → failed        any → rejected
```

State lives in each queue file's frontmatter; edit it by hand or use the
CLI. Hard rules enforced in code, not just convention:

- Case studies and anything blog-bound cannot be scheduled without
  `approved_by` (`pipeline/cli.py: cmd_schedule`, `store.requires_approval`).
- Case-study generation refuses a facts file with `complete: false`.
- Pacing is manual: nothing schedules itself. (`auto_publish.educational_linkedin`
  in `config.yaml` exists for the future auto-scheduler and starts off.)

## Facts files

`facts/_TEMPLATE.yaml` documents the contract. Fill in real details per
engagement, set `complete: true`. Empty `metrics: []` means drafts may
contain no result numbers at all; `public_name_ok: false` forces the
anonymous descriptor.

## Publishing

`publish-due` (or `publish <id>`) pushes out scheduled items whose time has
come. The approval gate is re-verified in code at publish time.

- **LinkedIn** items POST to the n8n workflow "Strauss AI — Content Publish"
  (`n8n/content-publish.workflow.json`, deployed and active at
  `https://n8n.ducksonaboat.ca/webhook/strauss-content-publish`). Auth is the
  `X-Publish-Token` header; the token lives in `.publish-token` (gitignored)
  and inside the workflow's Check Token node. Until the LinkedIn OAuth
  credential is connected in n8n, the workflow replies `posted: false`: the
  full text lands in Discord for manual posting and the item stays
  `scheduled` until you run `mark-published <id> --url <post url>`.
  To go fully automatic: connect a LinkedIn credential to the disabled
  "Post to LinkedIn" node, enable it, set Person, and change Respond OK's
  body to `{"ok": true, "posted": true}`.
- **Blog** items are published directly: frontmatter is built from the H1 +
  takeaway, the file lands in `strauss-ai-website/src/content/blog/`,
  committed, pushed, and deployed (`publishing.deploy_cmd`), then Discord is
  notified via the same webhook.

Cron (run on whatever machine has this repo + website repo + wrangler auth):

```
*/30 * * * * cd /Users/marcus/Documents/projects/content-generation-pipeline && .venv/bin/python -m pipeline publish-due >> publish.log 2>&1
```

## Not built yet

- Auto-scheduler for the educational LinkedIn lane once the evaluator has
  proven itself (flip `auto_publish.educational_linkedin`).
- **Agent orchestration layer** (planned, deliberately deferred). A Claude
  agent driving this CLI rather than replacing it:
  - *Weekly educational routine* — scheduled agent (cloud routine or local
    cron running `claude -p`) that tops up the queue when thin, slots passed
    posts into the cadence, runs `publish-due`, reports to Discord. Fully
    autonomous once the LinkedIn credential is wired and
    `auto_publish.educational_linkedin` is flipped.
  - *Facts-from-source agent* — given a repo README / project notes, drafts
    the engagement's `facts/<slug>.yaml` and leaves `complete: false` for
    Marcus to review. Facts extraction is automatable; publishing consent
    (naming permission, allowed metrics, do_not_mention) is not — Marcus
    always reviews the facts file once per engagement.
  - Approval stays human for case studies and blog in all versions of this;
    the agent's job is to reduce approval to a Discord ping + one-word
    reply, not to remove it.
