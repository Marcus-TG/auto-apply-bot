# GitCraft

Git-like version control for Minecraft builds. GitCraft is a Paper plugin that lets players snapshot, branch, diff, merge, push, pull, and restore regions of their world.

## What it is

GitCraft treats player-selected regions as commits. Each commit captures the structure of a region as a `.schem` file along with metadata (author UUID, timestamp, message). Snapshots are stored locally and can be pushed to GitHub via JGit — giving builds the same `commit / branch / push / pull / clone` workflow developers expect from source control.

GitCraft is **not** a block-change audit log. It does not track every block placed or broken. It captures whole-region snapshots on demand.

## Tech stack

| Layer              | Choice                                        |
|--------------------|-----------------------------------------------|
| Plugin platform    | Paper API (Paper 1.21.4)                      |
| Language           | Java 21                                       |
| Build tool         | Gradle + shadowJar (`com.gradleup.shadow`)    |
| Schematic format   | Sponge Schematic (`.schem`, v2/v3)            |
| Schematic I/O      | WorldEdit API (library dependency)            |
| Local storage      | SQLite (embedded)                             |
| Remote VCS         | GitHub (via JGit — pure Java, no native git)  |
| Git auth           | GitHub OAuth device flow → HTTPS token        |
| Deployment         | Docker + Portainer                            |

## Features

- Region selection with a configurable wand
- Local commits backed by Sponge `.schem` snapshots
- Per-player repositories with branches and active HEAD tracking
- Commit log, checkout, reset, diff, merge, cherry-pick, and stash commands
- Conflict previews with ghost blocks
- GitHub login, remotes, push, pull, and clone through JGit
- SQLite persistence with schema migrations

## Project layout

```
gitcraft/
├── build.gradle
├── settings.gradle
└── src/main/
    ├── java/com/gitcraft/
    │   ├── GitCraft.java          # Main plugin class
    │   ├── listeners/             # Event handlers (thin, no logic)
    │   ├── database/              # SQLite connection, schema, DAOs
    │   ├── commands/              # /gitcraft subcommands
    │   ├── export/                # Schematic generation via WorldEdit
    │   ├── commit/                # CommitService pipeline
    │   ├── diff/                  # DiffService, GhostBlockManager
    │   ├── merge/                 # MergeService, CherryPickService, OpManager
    │   ├── github/                # OAuth device flow
    │   └── git/                   # JGit wrappers (push, pull, clone, commit mapping)
    └── resources/
        ├── plugin.yml
        ├── database/schema.sql
        └── config.yml
```

## Commands

```
/gitcraft init <name>
/gitcraft open <name>
/gitcraft pos1
/gitcraft pos2
/gitcraft clear
/gitcraft commit <msg>
/gitcraft log [region] [page]
/gitcraft reset <id> [--hard]
/gitcraft branch [name]
/gitcraft checkout <branch>
/gitcraft diff [id1 id2]
/gitcraft merge <branch>
/gitcraft merge accept <ours|theirs>
/gitcraft merge continue
/gitcraft merge abort
/gitcraft cherry-pick <commit-id>
/gitcraft cherry-pick accept <ours|theirs>
/gitcraft cherry-pick continue
/gitcraft cherry-pick abort
/gitcraft stash [pop|list]
/gitcraft repos
/gitcraft login
/gitcraft logout
/gitcraft remote add <name> <url>
/gitcraft remote list
/gitcraft remote remove <name>
/gitcraft push [remote-name] [--force]
/gitcraft pull [remote-name] [--here]
/gitcraft clone <https-url> <repo-name> [--here]
```

## Prerequisites

- **JDK 21** (Temurin or equivalent)
- **Gradle 8+** (or use the included wrapper, `./gradlew`)
- **Paper 1.21.4** server for local testing
- **WorldEdit** plugin installed on that test server (runtime dependency)
- A pre-created GitHub repo for pushing. JGit cannot create repos, so the GitHub repo for a build must exist before the first push.

## Build

```bash
./gradlew shadowJar
```

The shadow JAR (with JGit and SQLite bundled) lands in `build/libs/`. The plain `jar` task is not used — always use `shadowJar` or `build` (which depends on it).

## Run locally

1. Set up a local Paper 1.21.4 test server (any directory outside this repo).
2. Install WorldEdit into the test server's `plugins/` folder.
3. Copy the built JAR into `plugins/`:
   ```bash
   cp build/libs/gitcraft-*.jar /path/to/paper-server/plugins/
   ```
4. Start the server:
   ```bash
   cd /path/to/paper-server
   java -Xmx2G -jar paper-1.21.4.jar nogui
   ```
5. On first launch the plugin generates `plugins/GitCraft/config.yml` and the SQLite database. Stop the server, edit config as needed, restart.

For iterative development, symlink the JAR instead of copying:

```bash
ln -sf "$(pwd)/build/libs/gitcraft-0.1.0.jar" /path/to/paper-server/plugins/gitcraft.jar
```

Then `./gradlew build` + `/reload confirm` (or full restart) picks up changes.

## Configuration

All runtime paths live in `config.yml`. Do not hardcode paths in source. Schematic storage can point at a mounted volume in production; locally it defaults to `plugins/GitCraft/schematics/`.

GitCraft also stores local JGit working trees under:

```yaml
github:
  git-dir: git     # Local JGit working trees (default: plugins/GitCraft/git/)
```

## License

MIT — see [LICENSE](LICENSE) for details.
