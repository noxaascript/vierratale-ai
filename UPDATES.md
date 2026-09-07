# UPDATES

Changes to VierrataleAI since the previous releases.

The project is shipped as two mirrored packages — the **Node CLI**
(`@vierratale/ai` on npm) and the **Python CLI** (`vierrataleai` on PyPI) —
and every feature below is implemented identically in both mirrors. The Node
and Python version numbers are listed together for each release.

## `0.1.0-beta.14` (npm) / `0.1.0b14` (PyPI)

### Installer
- The installer is now **`install.sh` at the project root** (this GitHub repo),
  a single source of truth for both runtimes. Interactive runs ask
  `NodeJS or Python? [N/P]` (flags: `--node`, `--python`, `--no-engine`,
  `--model NAME`, `--silent`, `--uninstall`, `--help`).
- It installs only requirements — the runtime, curl, the local AI engine
  (Cortex, "secretly" Ollama), and the model — then links the
  `vierrataleai`/`vierratale` commands into the first writable on-PATH bin
  dir. It does **not** re-install the app from npm or PyPI; this repo is the
  app.
- The in-app programmatic launcher installers (`installer.js` / `installer.py`)
  were removed. They are replaced by a slim runtime helper — `engine.js` /
  `engine.py` — that the CLI still uses to auto-install the engine/model on
  first run, resolve/substitute models, pull on demand, and power `/models`.
- `--install` / `--setup` still ensure the engine + model (with the animated
  progress), and now point the user to `install.sh` to create the global
  commands.
- The npm (`@vierratale/ai`) and PyPI (`vierrataleai`) packages keep both
  `vierrataleai` and `vierratale` bins but no longer ship an `install.sh` —
  that lives only in the project repo.
- `install.sh` started the engine with the current banner, `ollama pull` tier→
  model mapping matching the app catalog (`vierratale-fast` → `gemma3:1b`,
  `vierratale-lite` → `qwen3:0.6b`, …), Termux-safe pip bootstrap (no
  `python3-pip` package), picks the Python that has `rich`, and flags a missing
  `curl` up front.

### Launcher / command
- Both `vierrataleai` and `vierratale` commands are created/refreshed by the
  installer, pointing at this repo's launcher (Node symlink or a Python shim
  with `PYTHONPATH` set), placed in the first writable dir already on `PATH`
  (`/usr/local/bin` or `/usr/bin`, falling back to `~/.local/bin`) with a
  PATH-export hint when needed.
- Running the assistant (plain `vierrataleai` / `vierratale`) auto-detects
  dependencies: if the engine or model is missing it is installed first, with
  the "Checking engine … Ready" step (`--version`/`--help` skip the check).
  This matches across both mirrors.

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