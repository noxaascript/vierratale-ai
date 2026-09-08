# UPDATES

Changes to VierrataleAI since the previous releases.

The project is shipped as two mirrored packages — the **Node CLI**
(`@vierratale/ai` on npm) and the **Python CLI** (`vierrataleai` on PyPI) —
and every feature below is implemented identically in both mirrors. Every
published version is listed here, newest first; the Node and Python version
numbers are listed together for each release.

## `0.1.0-beta.16` (npm) / `0.1.0b16` (PyPI)

### Catalog trimmed to the 5 installed models
- The catalog is now limited to the models actually installed locally:
  `VTL-2.7-Flash` (gemma3:1b), `VTL-2.9-Core` (llama3.2:1b),
  `VTL-3.1-Plus` (qwen2.5:1.5b), `VTL-3.3-Pro` (qwen2.5-coder:1.5b) and
  `VTL-3.5-Reason` (qwen3:1.7b). All 9 cloud entries and the uninstalled
  local entries were removed; the legacy names for removed models no longer
  resolve.
- `install.sh --model` pull list updated to match; cloud gems (creator,
  chat, release) still install in the background when configured.

### Bug fixes
- **Engine**: the default model is now actually downloaded on startup
  when missing — the auto-pull was silently skipped because the "already
  installed?" check always matched.
- **Cloud providers** (OpenAI / Anthropic / Gemini) no longer send local
  ollama tags (e.g. `gemma3:1b`) to the cloud APIs; a local or unknown model
  now falls back to a real provider default (`gpt-4o-mini` /
  `claude-3-5-haiku-20241022` / `gemini-2.0-flash`).
- **CLI**: a local ollama model is no longer force-downloaded when a cloud
  provider is active.
- **Node timeouts**: command/plan timeouts aligned with the Python mirror
  (300 s).

### vCPU / VRAM defaults
- `vcpu` gained a `spec` command printing RTX 5090-class virtual specs; the
  default engine now exposes 32 virtual cores.
- `vram` default pool raised to 64 GB virtual VRAM with 32 threads; vgpu
  bench default size raised to 512 MB.

## `0.1.0-beta.15` (npm) / `0.1.0b15` (PyPI)

### Rebrand: VTL model catalog (no vendor names shown)
- The whole catalog was renamed to the **VTL** scheme. Users only ever see
  opaque VTL display names — the underlying engine tags (qwen, gemma, llama,
  glm, kimi, gpt-4o, claude, gemini, …) and the word "Ollama" are hidden from
  every user-facing surface (CLI, `/models`, errors, help, installer, README).
- Catalog now has **21 models — 12 local + 9 cloud**:
  - Local: VTL-2.5-Mini, VTL-2.7-Flash, VTL-2.9-Core, VTL-3.2-Orbit,
    VTL-3.1-Plus, VTL-3.3-Pro, VTL-3.5-Reason, VTL-3.7-Ultra, VTL-4.7-Gusto,
    VTL-5.4-Tempo, VTL-5.2-Pinnacle, VTL-5.9-Sovereign.
  - Cloud: VTL-4.0, VTL-4.2-Omni, VTL-4.5-Plus, VTL-5.0-Pro, VTL-6.0-Reason,
    VTL-7.0-Omnij, VTL-8.0-Fabric, VTL-9.0-Forge, VTL-10.0-Singularity.
  - Newly added: GLM-powered VTL-5.2-Pinnacle, Kimi-powered VTL-8.0-Fabric,
    VTL-9.0-Forge and VTL-10.0-Singularity, plus lightweight options
    VTL-3.2-Orbit, VTL-4.7-Gusto, VTL-5.4-Tempo and VTL-5.9-Sovereign.
- Legacy `vierratale-*` and old `VRTL-*` names still work (config files keep
  resolving) and normalize to the new VTL names. The default model is now
  `VTL-2.7-Flash` in both mirrors; `install.sh --model` accepts VTL names.
- `/models`, self-intent messages, error guidance and CLI help now show only
  VTL display names; the raw engine tag listing is replaced with an
  "additional engine models available" count.

### Virtual CPU / VRAM / VGPU benchmark suite
- `vcpu` now takes a configurable core count:
  `... vcpu plan|self|engine|server|bench --cores N` (or
  `VIERRATALE_VCPU_CORES`); the engine-server mode runs foreground
  (`vcpu server --cores N`), pinned to the set.
- `vram` gained flags (`--pool MB --threads N --latency`) and reports
  per-read latency (ns) alongside throughput.
- **New `vgpu`** module in both mirrors: a float32 matmul kernel fanned out
  over the vCPU threads, reporting GFLOPS / TOPS and effective bandwidth
  (`python -m vierrataleai.vcpu.vgpu` / `node vcpu/vgpu.js`).
- `vcpu bench [--cores N]` runs the whole suite — vCPU plan, VRAM bandwidth +
  latency, and VGPU matmul — in one shot, pinned to the chosen cores.

## `0.1.0-beta.14` (npm) / `0.1.0b14` (PyPI)

### Installer
- The installer is now **`install.sh` at the project root** (this GitHub repo),
  a single source of truth for both runtimes. Interactive runs ask
  `NodeJS or Python? [N/P]` (flags: `--node`, `--python`, `--no-engine`,
  `--model NAME`, `--silent`, `--uninstall`, `--help`).
- It installs only requirements — the runtime, curl, the local AI engine
  (Cortex), and the model — then links the
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
- `install.sh` started the engine with the current banner, an engine-pull tier→
  model mapping matching the app catalog (`vierratale-fast`,
  `vierratale-lite`, …), Termux-safe pip bootstrap (no
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

## `0.1.0-beta.13` (npm) / `0.1.0b13` (PyPI)

### Installer & launchers
- Installer rewritten to install only requirements — the runtime (Node.js or
  Python), the local AI engine (Cortex) and the model — then link the command
  into the first writable on-PATH bin dir, without re-installing the app from
  npm/PyPI (this repo is the app).
- Both `vierrataleai` and `vierratale` launchers ship for each runtime (Node
  symlink / Python shim with `PYTHONPATH`).
- READMEs and docs updated to match; first full publish pass of both mirrors.

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

## `0.1.0-fixfetch-beta9.5` (npm) / `0.1.0b8.dev5` (PyPI)

### Web fetch hardening
- Patch release between the beta.9/b8 and beta.10/b9 full releases: hardened
  `/fetch` and the model's web tooling so failed or mis-labelled fetches
  return clean, usable results instead of errors. The full WebFetch
  feature set landed in the following beta.11/b10 release.

## `0.1.0-beta.1` – `0.1.0-beta.9` (npm) / `0.1.0b1` – `0.1.0b8` (PyPI)

### Early development series
The first releases established the core assistant. Detailed per-version notes
for these early betas were not recorded; the following is a cumulative summary
of what this series delivered:
- Terminal chat assistant that runs AI models locally (Cortex engine) and in
  the cloud (OpenAI / Anthropic / Gemini) with automatic provider detection
  and `vierratale-*` model names.
- Slash-command set: `/help`, `/model`, `/provider`, `/models`, `/system`,
  `/search`, `/fetch`, `/log`, `/clear`, `/new`, `/quit`.
- Smart web search — questions (who/what/when/where/why/how) and bare topic
  mentions trigger a live search with AI-summarized answers; `/search <query>`
  forces one explicitly.
- Story-mode replies saved to a `<subject>.txt` file; generic `tell me a
  story` replies are also saved to a `.txt` file.
- File writing: `FILE:`/`FOLDER:` blocks, automatic filename inference,
  nested-folder creation, and safe overwrite handling.
- Full-screen chat UI with language-tagged code boxes, automatic per-day
  logging under `~/.config/vierrataleai/logs/`, and conversation memory
  restored on the next launch.
- Continuous provider-specific fixes (local-engine substitution, cloud model
  routing) shipped across the series.