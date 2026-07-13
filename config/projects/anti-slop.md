# Anti-Slop

Multi-agent context routing for AI coding workflows. Mac desktop app that lets you run multiple AI coding agents side by side, stage context (files, snippets, agent output), and route it into whichever agent needs it — without leaving the app.

See [`AGENTS.md`](./AGENTS.md) and [`CLAUDE.md`](./CLAUDE.md) for the project brain.

## Setup

```bash
npm install
npm run rebuild-native   # one-time: rebuild node-pty against Electron's ABI
npm run dev
```

The `rebuild-native` step is required only once after `npm install` (or whenever Electron is upgraded). If panel **Start** buttons spawn nothing or you see a node-pty ABI mismatch error in the console, rerun it.

## Usage

1. **Open a working directory** from the toolbar (required before starting non-isolated panels).
2. Configure any idle panel from its header: pick an agent (Claude Code, Codex, or Gemini CLI), edit the **role label** (free text, defaults to "Agent"), and toggle **Isolated** and **Plan**. Click **Start** to spawn the selected CLI (`claude`, `codex`, or `gemini`).
   - **Isolated** panels spawn from a temp directory with no working-dir access and receive the vision-holding system prompt (native `--system-prompt` for Claude; prepended for Codex/Gemini). Non-isolated panels run against the open directory.
   - **Plan** starts the session in plan mode (Claude enforces via `--permission-mode plan`; Codex/Gemini get an advisory instruction). Agent, role, isolation, and plan all lock once the session is running.
3. Add panels with **+ Panel** in the toolbar (up to 10); close an agent panel from its tab to delete it (stopping its session). Stage context from the **Files** tree, the staging **Paste** action, or an agent response's **Stage** action.
4. Type into the prompt input and press Enter to send. Use Shift+Enter for a newline. Staged items prepend to a normal prompt and non-global staged items clear after send.
5. Click **Molt** (shown on isolated panels) to compact the session into a fresh one. Claude advances after its summary completes; the flow waits for **Use Summary** or **Cancel** if needed.
6. Click **Stop** in a panel's header to terminate the session.

Panels are dockable: drag a tab to any edge to tile it, or drop it onto another to stack as tabs. The **Files** and **Staging** utility panels can be closed and reopened from the toolbar's **Panels** menu. The layout, panel set, and per-panel config are remembered and restored on the next launch.

## Current State

- Agent panels are dynamic: add (up to 10) / remove them, each with a free-text role label, an agent type, and isolation + plan toggles. First launch seeds an isolated "Visionary" and two non-isolated workers. Panels are dockable/tab-stackable; panel config + layout persist across launches.
- Closing an agent panel deletes it and stops its session; the Files and Staging utility panels are closable/reopenable from the **Panels** menu.
- Isolation (idle-only toggle) drives the sandbox + vision-holding system prompt + Molt; non-isolated panels run against the open working directory.
- Files, directories, pasted text, and stageable agent responses can enter the staging area; prompt assembly adapts file refs and snippets per agent.
- Every panel has an idle-only **Plan** toggle — enforced for Claude Code (`--permission-mode plan`), advisory-only for Codex and Gemini.
- Manual Molt exists for isolated panels (plan mode preserved across the reset). Automatic molt triggers, token warnings, history, and per-panel routing controls are still future work.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run Electron + Vite in development mode |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check (no emit) |
| `npm run rebuild-native` | Rebuild node-pty for Electron's ABI |

## Requirements

- macOS
- Node 18+
- One or more of the supported CLI agents installed and authenticated: `claude`, `codex`, `gemini`

## Docs

Keep `README.md`, `AGENTS.md`, and `CLAUDE.md` updated together when supported agents, user workflows, architecture, shared types, or milestone status changes.
