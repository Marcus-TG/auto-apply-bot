# dotfiles

My macOS / Linux terminal setup — Ghostty, zsh, starship, Neovim, and friends,
themed Catppuccin Mocha throughout. This is the public mirror of my personal
dotfiles, shared as-is; take whatever is useful.

## Install

```sh
git clone https://github.com/Marcus-TG/.files.git ~/dotfiles
cd ~/dotfiles
./install.sh
```

`install.sh` detects the OS, installs packages, then symlinks the configs into
place. Existing `~/.zshrc` and `~/.gitconfig` are backed up to `*.backup`
before linking. Package sources by platform:

- **macOS** — Homebrew
- **Arch** — `yay`
- **Ubuntu/Debian** — `apt` for what's packaged, plus the official installers
  (starship, atuin), `cargo` (yazi, tree-sitter-cli), and GitHub release
  binaries (lazygit, lazydocker) for the rest. `bat` is symlinked from
  `batcat`. Ghostty has no apt package — install it manually.

> **Note:** `git/.gitconfig` ships with a placeholder identity — set your own
> name and email before committing anything.

## What's here

| Path    | Symlinked to       | Purpose                                  |
| ------- | ------------------ | ---------------------------------------- |
| `zsh/`  | `~/.zshrc`         | Shell aliases, completion, tool init     |
| `git/`  | `~/.gitconfig`     | Git identity and URL rewrites            |
| `nvim/` | `~/.config/nvim`   | Neovim config (kickstart.nvim based), with local AI completion via [minuet](https://github.com/milanglacier/minuet-ai.nvim) + Ollama |
| `ghostty/` | `~/.config/ghostty` | Ghostty terminal config + GLSL cursor-trail shader |
| `starship/` | `~/.config/starship.toml` | Catppuccin Mocha prompt          |
| `bat/`  | `~/.config/bat`    | `bat` theme (Catppuccin Mocha)           |
| `ai/`   | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` | Global instructions for Claude / Codex / Gemini CLIs |

## Aliases

Defined in `zsh/.zshrc`:

| Alias | Expands to          | Purpose                 |
| ----- | ------------------- | ----------------------- |
| `ls`  | `ls --color=auto`   | Colorized listing       |
| `grep`| `grep --color=auto` | Colorized matches       |
| `lg`  | `lazygit`           | Git TUI                 |
| `ld`  | `lazydocker`        | Docker TUI              |
| `..`  | `cd ..`             | Up one directory        |
| `...` | `cd ../..`          | Up two directories      |
| `....`| `cd ../../..`       | Up three directories    |

## Tools

Installed via `install.sh`:

- **eza** — `ls` replacement
- **bat** — `cat` replacement
- **zoxide** — smarter `cd`
- **starship** — shell prompt
- **atuin** — shell history
- **yazi** — terminal file manager
- **fastfetch** — system info on shell start
- **lazygit** / **lazydocker** — git and docker TUIs
- **colima** + **docker** / **docker-compose** — container runtime
- **ghostty** — terminal emulator

## License

MIT — see [LICENSE](LICENSE). The Neovim config is built on
[kickstart.nvim](https://github.com/nvim-lua/kickstart.nvim) (MIT, license
included in `nvim/`).
