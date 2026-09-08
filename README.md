# VierrataleAI

Intelligent terminal assistant that runs AI models locally and in the cloud.

VierrataleAI is a chat assistant that works right in your terminal. It runs
local models through the **Cortex** engine and can switch to cloud models
(OpenAI, Anthropic, Gemini). It searches the web, writes files, and remembers
your conversations — all from the command line.

## Quick start

```bash
git clone https://github.com/<you>/vierratale-ai.git
cd vierratale-ai

./install.sh --node     # or --python (default); installs everything
vierratale               # start chatting
```

`./install.sh` installs only **requirements** — the runtime (Node.js or
Python), the local AI engine (Cortex), and the model — then links the
`vierrataleai` and `vierratale` commands on your PATH. It does **not**
re-install the app from npm or PyPI; this repo is the app.

Even if you skip the installer, the assistant is self-healing: the first
`vierratale` run detects anything missing (engine, model, runtime) and installs
it automatically before opening the chat.

### Installer options

```bash
./install.sh                # interactive (asks "NodeJS or Python? [N/P]")
./install.sh --node         # use the Node.js version
./install.sh --python       # use the Python version
./install.sh --model NAME   # pick the local model (default: VTL-2.7-Flash)
./install.sh --no-engine    # skip engine / model installation
./install.sh --silent       # all defaults, no prompts
./install.sh --uninstall    # remove the commands + config
./install.sh --help
```

### Or install from a package registry

```bash
# Node.js
npm install -g @vierratale/ai

# Python
pip install vierrataleai
```

## Usage

```bash
vierrataleai                          # Start chat (auto-detect provider)
vierrataleai --provider cortex        # Use local models
```

`vierratale` and `vierrataleai` are the same command.

## Models

Local models run through the **Cortex** engine:

| Model | Tier |
|-------|------|
| VTL-2.7-Flash | fast |
| VTL-2.9-Core | small |
| VTL-3.1-Plus | balanced |
| VTL-3.3-Pro | coder |
| VTL-3.5-Reason | reasoning |

Legacy `vierratale-*` and old `VRTL-*` names (e.g. `vierratale-fast`) still
work and map to the VTL names.

## Commands

- `/help` - Show commands
- `/model [name]` - Switch model
- `/provider [name]` - Switch provider
- `/models` - List available models
- `/system [text]` - Set a custom system prompt / persona
- `/search <query>` - Search the web and summarize with AI
- `/fetch <url>` - Open a link and summarize its content
- `/log [n|path]` - Show the last n log entries (default 30) or the log file path
- `/clear` - Clear screen
- `/new` - Start a new conversation (clear memory)
- `/quit` - Exit

## Features

- **Smart search** — Who/What/When/Where/Why/How... questions trigger a live web
  search and summarize the results; bare topic mentions and story requests work
  the same way.
- **File writing** — ask for code, configs, scripts, or pages and they are
  written to disk automatically with `FILE:`/`FOLDER:` blocks.
- **Chat UI** — a clean full-screen terminal interface with streaming replies
  and syntax-tagged code boxes.
- **Automatic logging** — every session is logged to
  `~/.config/vierrataleai/logs/` and inspectable with `/log`.
- **Conversation memory** — chats are saved and restored on the next launch.
- **Self-healing installer** — missing engine, model, or runtime are installed
  on first run.

## Configuration

Config file: `~/.config/vierrataleai/config.json`

Environment variables:

- `VIERRATALE_PROVIDER` - Default provider (auto/cortex/openai/anthropic/gemini)
- `VIERRATALE_MODEL` - Default model
- `OPENAI_API_KEY` - OpenAI API key (openai provider)
- `ANTHROPIC_API_KEY` - Anthropic API key (anthropic provider)
- `GEMINI_API_KEY` - Google AI API key (gemini provider)

## Repository layout

```
├── install.sh      # installer: requirements + command linking
├── nodejs/         # Node.js implementation (npm package @vierratale/ai)
├── python/         # Python implementation (PyPI package vierrataleai)
└── UPDATES.md      # changelog
```

## Development

```bash
# Node.js tests
cd nodejs && node --test "test/*.test.js"

# Python tests
cd python && python3 -m unittest discover -s tests -q
```

## License

MIT