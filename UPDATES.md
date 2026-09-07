# UPDATES

Changes to VierrataleAI since the previous releases.

The project is shipped as two mirrored packages — the **Node CLI**
(`@vierratale/ai` on npm) and the **Python CLI** (`vierrataleai` on PyPI) —
and every feature below is implemented identically in both mirrors. The Node
and Python version numbers are listed together for each release.

## Unreleased (next: `0.1.0-beta.13` / `0.1.0b12`)

### Installer fixes
- `--install` now puts the `vierrataleai` command somewhere it can actually be
  run: it is placed in the first writable bin dir that is already on `PATH`
  (`~/.local/bin` only when that dir is on `PATH`, else `/usr/local/bin` or
  `/usr/bin`), instead of always `~/.local/bin`.
- Re-running the installer replaces stale/foreign launchers (e.g. a leftover
  shim from the other runtime or a dangling symlink), so the command always
  matches the version you just installed.
- If no writable `PATH` dir was found, the CLI prints the exact `PATH`-export
  line to add, instead of silently "succeeding".
- Starting the assistant (plain `vierrataleai` / `node bin/vierrataleai.js`)
  now auto-detects dependencies: if the AI engine (ollama) or the model is
  missing it is installed first, with the animated "Checking engine … Ready"
  step — installs happen on demand without needing `--install` (`--version`
  and `--help` skip the check). This matches the Python CLI's existing
  start-time `ensure()`.
- The launcher is created under **both** names: `vierrataleai` and `vierratale`
  (`Installer.install()` returns `command` + `commandAlias`; npm now ships both
  bins in `package.json`, and PyPI declares both console scripts). Running
  `vierratale` starts the assistant the same way.
- `install.sh` was rewritten: it no longer re-installs the app from npm or
  PyPI — this repo *is* the app. It now only installs requirements (curl, the
  runtime, the engine, the model), links the `vierrataleai`/`vierratale`
  commands into a writable on-PATH bin dir, and uses the same banner as the
  CLI (the previous installer had the old ASCII art). It also picks the Python
  that can actually run the app (has `rich`), avoids overwriting source
  through symlinks when relinking commands, and `package.json` was added back
  to the Node source so `npm install`/`npm pack` work again.
- `install.sh`: the model pull invoked the non-existent `engine` command; it
  now uses `ollama pull`, the tier→model table matches the app catalog
  (`vierratale-fast` is `gemma3:1b`, `vierratale-lite` is `qwen3:0.6b`, …), a
  failed pull reports a warning instead of a misleading success, pip is
  bootstrapped correctly on Termux (no `python3-pip` package exists there),
  and a missing `curl` is flagged up front.

### File tree after creating folders/files
- When the agent creates a folder or file, the resulting workspace structure is
  now shown as a box-drawing file tree right after the tool run (e.g.
  `└── demo` / `├── demo/halo.txt`), so you can see at a glance what the AI
  built on disk.
- The tree is bounded (max depth 4, max 150 entries) and skips noise folders
  (`.git`, `node_modules`, `__pycache__`, `.cache`) so huge workspaces never
  flood the chat.

### Install packages with apt / pkg
- The AI can now install system packages the user asks for (`install curl`,
  `pasang wget`, `pkg install lsof htop`, `apt install jq`):
  - `apt`, `apt-get` and `pkg` were added to the shell tool's allowed commands.
  - The `-y`/`--yes` confirm flag is added automatically to mutating
    subcommands (`install`/`upgrade`/`remove`/…), so installs never hang on a
    prompt and work in the non-interactive tool runner.
  - The request heuristics plan an install with the right manager for the
    platform (`pkg` on Termux/Android, `apt`/`apt-get` on Linux), the model's
    tool docs teach the same, and anything that still sounds like
    JavaScript/Python dependency management (npm, pip, "node modules", …)
    stays out of the system manager's way.

## `0.1.0-beta.12` (npm) / `0.1.0b11` (PyPI)

### Todos
- New `/todos` slash command to manage a todo list stored in
  `.todos.json` inside the current workspace:
  - `/todos` — list all todos
  - `/todos add <text>` — add a todo
  - `/todos done <n>` / `/todos undone <n>` — mark a todo done / not done
  - `/todos <n>` — toggle a todo with no arguments
  - `/todos remove <n>` — delete a todo
  - `/todos clear` — clear the whole list
- The AI agent can also use the todo list directly through four new tools:
  `todo_add`, `todo_list`, `todo_update`, `todo_clear`. They are registered in
  the tool dispatcher, accepted by the tool-plan parser, and documented in the
  agent's system prompt so the model can plan multi-step work (create a todo
  per subtask, then mark each step done as it runs).

### Auto error fixing
- When a planned tool call fails (non-zero exit code or exception), the agent
  now feeds the failure details (stderr / exit code) back to the model and asks
  it for a corrected plan, which is executed immediately instead of giving up.
- Bounded and safe: at most 3 auto-fix attempts per request, and fixes are
  subject to the same overall step limit as normal planning rounds, so the CLI
  can never loop forever on a stubborn failure.

## `0.1.0-beta.11` (npm) / `0.1.0b10` (PyPI)

### WebFetch — "fetch any website"
- `/fetch <url>` and the model's `download_url` / web tooling now load **any
  website**, not just plain text:
  - Content-type aware: `html`, `json`, `xml`, `markdown`, `text`, `pdf`,
    `binary` (with body sniffing when a server mislabels the content).
  - Proper character decoding: header charset, `<meta charset>` tags, and a
    `windows-1252` fallback for pages that lie about their encoding.
  - JSON responses are flattened into readable `key: value` lines.
  - RSS/Atom feeds are summarized as item title/link/description lists;
    sitemaps become a plain list of URLs.
  - SPA pages are extracted from embedded JSON (`__NEXT_DATA__`,
    `application/ld+json`, `window.__PRELOADED_STATE__`).
  - Thin HTML pages append a `[Links on page]` listing.
  - Retries: falls back to plain `http` on transport errors and retries with
    an alternate user-agent when a 403/429 wall blocks the default one.
  - Wall detection reports blocked pages instead of returning garbage.
- Full test coverage added in both mirrors (14 WebFetch tests each); both
  suites are green.

## `0.1.0-beta.10` (npm) / `0.1.0b9` (PyPI)

### Terminal UI polish
- `/`-command popup: typing `/` opens a live-filtering list of all slash
  commands directly above the input line.
- Bottom-anchored chat box: the composer is fixed at the bottom of the screen
  (via a screen compositor) instead of floating in the scrollback, so prompts
  stay visible while the conversation flows above.
- Raw-mode line editor with history, arrow keys, and friendlier input
  handling; busy behavior queues Enter presses while the AI is streaming.
- Non-TTY fallbacks (readline) so the CLI still works piped / in scripts.

### Reliability
- Python agent loop (`cli.py` ↔ `cmd/agent.py`) fully aligned with the Node
  mirror — same plan parsing, tool execution, and session handling.
- Input-history recording fixed on both mirrors; the full Node and Python
  test suites (153 tests each at the time) pass.