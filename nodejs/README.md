# VierrataleAI

Intelligent terminal assistant that runs AI models locally and in the cloud.

## Install

Install requirements and run from source:

```bash
git clone <your-repo-url>/vierratale-ai.git
cd vierratale-ai

./install.sh --node   # installs requirements + links the commands
vierratale             # start chatting
```

Or run directly from npm:

```bash
npm install -g @vierratale/ai
npx @vierratale/ai
```

The first launch detects and, if needed, installs and starts the local engine
(**Cortex**), then pulls the model you use.

## Usage

```bash
vierrataleai                          # Start chat (auto-detect provider)
vierrataleai --provider cortex        # Use local models
vierrataleai --model VTL-3.3-Pro     # Use specific model
```

## Models

Local models run through the **Cortex** engine:

| Model | Tier |
|-------|------|
| VTL-2.7-Flash | fast |
| VTL-2.9-Core | small |
| VTL-3.1-Plus | balanced |
| VTL-3.3-Pro | coder |
| VTL-3.5-Reason | reasoning |

> Legacy `vierratale-*` and old `VRTL-*` model names (e.g. `vierratale-fast`)
> still work and map to the VTL names.

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

## Smart Search

Asking a question (Who/What/When/Where/Why/How...?) automatically searches the
web and summarizes the results with AI. Bare mentions of specific topics also
trigger a search — e.g. `timun mas from indonesia`, `the legend of roro
jonggrang`. For example:

```
> Who is Cristiano Ronaldo?
> timun mas from indonesia
```

triggers a live web search and answers from the results. If no web results come
back, the AI answers from its own knowledge instead of going quiet. Use
`/search <query>` to force a search explicitly.

Story requests about any subject work the same way — no matter how they're
phrased (`a story about X`, `the legend of X`, `tell me about X`, `narrate the
tale of X`, `write X into a txt file`). The subject is pulled out of the
sentence, searched first, and the reply is saved to a `<subject>.txt` file.
A generic `tell me a story` (no subject) is told directly from the model — and
is also saved to a `.txt` file.

Greetings (`hi`, `hello`, `hey`, `good morning`, ...) are answered instantly
with a short fixed reply — they never reach the model.

## Writing Files

Ask the AI to create code, configs, scripts, web pages, or a whole project. When it
responds, it lists each file with a `FILE: <path>` header followed by a code
fence (and `FOLDER: <path>` for empty folders) — just running in the chat writes
them to your disk in the current working directory. Any file type is supported,
including JSON config files and HTML pages. Nested folders are created automatically, existing
files are skipped unless you confirm to overwrite, and nothing is ever written
outside the working directory.

If the AI ever answers with the code but forgets the `FILE:` header (or writes an
HTML page without a fence), the assistant rescues it: any `FILE: <path>` line in
the reply is honored even without a fence, otherwise the request is used to
infer a filename and the code block is saved anyway. Filename inference covers
many formats, not just web pages:

| Request contains… | Saved as |
|--------------------|----------|
| `html` / `webpage` / `website` / `page` | `index.html` |
| `css` | `style.css` |
| `python` / `py` | `script.py` |
| `flask` / `django` / `fastapi` / `streamlit` / `app` | `app.py` |
| `javascript` / `js` / `script` | `script.js` |
| `typescript` / `ts` | `script.ts` |
| `bash` / `zsh` / `shell` | `script.sh` |
| `json` / `yaml` / `yml` / `csv` / `sql` | `output.json` / `.yml` / `.csv` / `.sql` |

When the request has no hint at all, the fence language in the reply picks the
name (```python → `script.py`, ```css → `style.css`, …). Saving also kicks in
whenever the reply itself contains a `FILE:`/`FOLDER:` line, or when a reply is
basically just one substantial code block, even if the request phrasing wasn't
matched.

For file requests, a short format instruction is silently attached to your
message so the model emits complete `FILE:` blocks with closed fences. And if
the model ever answers a file request *without any code* (free-style prose,
interrupted before a fence), nothing is saved and you get a notice telling you
to ask again — a `.py` file full of chatter is never created.

Example of what the AI emits:

```
FILE: config.json
```json
{
  "name": "my-app",
  "port": 3000
}
```

FILE: index.html
```html
<!doctype html>
<html><body>Hello</body></html>
```

FILE: src/hello.js
```js
console.log('Hello VierrataleAI');
```

## Chat UI

The chat runs in a clean, minimal full-screen interface: your turns are labelled
`You` and the assistant's `AI`, with plain wrapped text in between. Code blocks
are the exception — they render inside a green bordered box with their language
tag (`╭─ html ─╮`), so files stand out at a glance. The latest reply stays pinned
to the bottom of the terminal while it streams in (no screen flashing), and
internal search/fetch context stays hidden.

## Automatic Logging

Everything that happens in a session is written automatically to a per-day log
file in `~/.config/vierrataleai/logs/` (e.g. `vierrataleai-20260101.log`):
app/session start, every user message, every AI reply, every file write or
skip, and any errors — with a timestamp. The logs are plain text and safe to
grep. To inspect them from inside the chat:

```
/log          # show the last 30 entries
/log 100      # show the last 100 entries
/log path     # print the log file path
```

## Conversation Memory

Your conversation is saved automatically and restored on the next launch, so
you can continue where you left off. Use `/new` to start fresh.

## Configuration

Config file: `~/.config/vierrataleai/config.json`

Environment variables:
- `VIERRATALE_PROVIDER` - Default provider (auto/cortex/openai/anthropic/gemini)
- `VIERRATALE_MODEL` - Default model
- `OPENAI_API_KEY` - OpenAI API key (openai provider)
- `ANTHROPIC_API_KEY` - Anthropic API key (anthropic provider)
- `GEMINI_API_KEY` - Google AI API key (gemini provider)

## License

MIT
