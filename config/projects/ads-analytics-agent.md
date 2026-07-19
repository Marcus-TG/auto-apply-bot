# Strauss AI — Ads & Analytics Agent Workspace

This folder is the working environment for an AI agent (Claude Code) that reads and
reasons about **Strauss AI's Google Ads and Google Analytics data** — its own account
and agency client accounts. It is not an app or a deployable project; it's context,
credentials wiring, and helper tools that let the agent answer questions like
"how did the campaign do this week?", pull conversion data, and generate keyword
and ad-copy ideas.

## What it does

- **Reports on ad performance** — campaigns, spend, clicks, conversions — via a
  read-only Google Ads MCP server (GAQL queries routed through the Strauss AI MCC).
- **Reports on site analytics** — sessions, leads, traffic sources, Search Console
  queries — via a Google Analytics MCP server against the Strauss AI GA4 property.
- **Generates ad inputs** — keyword ideas (Keyword Planner), trend data (Google
  Trends), and RSA ad copy — using the scripts in `tools/`.

## What it deliberately can't do

**Everything here is read-only.** The wired credentials and MCP servers cannot
create, pause, edit, or delete campaigns, budgets, keywords, or assets — and there
are no spending actions of any kind. Changes to accounts are made by a human in the
Google Ads UI; the agent can only describe what to change.

## Folder layout

| File / dir | Purpose |
|---|---|
| `CLAUDE.md` | The agent's operational reference: accounts, auth, MCP tools, API endpoints, GAQL/GA4 cheat-sheets, reporting conventions. Start here. |
| `AGENTS.md` | Symlink to `CLAUDE.md` (same instructions for other agent harnesses). |
| `straussai.md` | Strauss AI's own account context: business profile, offer/economics, advertising philosophy, live campaign build, to-dos. |
| `luke.md` | Agency client context: Luke Chin Photography — business, campaigns, conversion tracking, gotchas. |
| `tools/` | Keyword & ad-copy generation scripts (`keyword_ideas.py`, `trends.py`) — see `tools/README.md` for setup and usage. |

Per-account detail lives in its own file (`straussai.md`, `luke.md`) so `CLAUDE.md`
stays lean; new agency clients get their own file following the same pattern.

## Accounts covered

- **Strauss AI** — ad account `277-778-6697`, GA4 property `543525039` (straussai.ca)
- **Strauss AI MCC** — manager account `550-774-6015` (routing parent + API developer token)
- **Luke Chin Photography** — client ad account `637-068-2592`, under the MCC

All accounts are CAD / America/Toronto.

## Credentials (not in this folder)

Auth uses Google Application Default Credentials plus a GA4 service account, both
stored under `~/.config/gcloud/` — nothing secret is checked into this folder.
Setup and re-auth instructions are in `CLAUDE.md` under "How access works".
