# Lazy AI

An always-on AI overlay companion for **Windows** that does the tedious work so you don't
have toc

> **Roadmap:** [PROJECT_PLAN.md](PROJECT_PLAN.md) · **Agent/dev notes:** [CLAUDE.md](CLAUDE.md)

## The three pillars

1. **Prompt Polisher** *(built)* — rewrite messy prompts into clean, structured,
   token-efficient ones, in place, without switching tabs.
2. **Screen Teacher** *(planned)* — hotkey → screenshot → voice/text question → Claude
   answers with annotations drawn on screen.
3. **Screen Control** *(planned)* — voice command → app clicks/opens things for you.

## Architecture: "two faces, one brain"

```
lazy-ai/             # THE BRAIN — Electron desktop app
                     #   holds API keys (.env), runs the polish engine,
                     #   hosts a local server at http://localhost:8788
        ▲
        │ http://localhost:8788/polish
        │
lazy-ai-extension/   # THE IN-TAB FACE — MV3 browser extension
                     #   floating button + in-page panel, replaces text in place;
                     #   holds NO keys/logic, just calls the desktop server
```

Keys live in exactly one place (the desktop app). The extension is a thin client — safe,
since browser extensions are trivially unpacked and must never hold secrets. The
`/polish` endpoint is the same contract as a future Cloudflare Worker, so deploying later
only changes a URL.

## Setup & run

### 1. Desktop app (the brain — also serves the extension)

```powershell
cd <repo-root>                                   # wherever the folder lives (e.g. D:\Lazy AI)
npm install --prefix lazy-ai                     # first time only
Copy-Item lazy-ai\.env.example lazy-ai\.env      # then paste your API key(s)
npm start --prefix lazy-ai
```

At minimum set `ANTHROPIC_API_KEY` in `.env` (the default model is Claude Haiku 4.5).
Add `GEMINI_API_KEY` / `OPENAI_API_KEY` to use the other dropdown options.

### 2. Browser extension (with the desktop app running)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select the `lazy-ai-extension` folder.
4. On any page with a text box, click the floating Lazy AI button, review the polished
   prompt, and hit **Replace**.

The desktop app must be running — it's the brain the extension calls.

## Models (Prompt Polisher)

| UI label | API model id | Provider | Env var |
|----------|-------------|----------|---------|
| Claude Haiku 4.5 (default) | `claude-haiku-4-5` | Anthropic | `ANTHROPIC_API_KEY` |
| Gemini 3.1 Flash Lite | `gemini-3.1-flash-lite` | Google | `GEMINI_API_KEY` |
| GPT-5.4 Nano | `gpt-5.4-nano` | OpenAI | `OPENAI_API_KEY` |

Model ids are defined in `lazy-ai/src/polish-engine.js`. If a provider 404s on a model,
fix the `apiModel` value there (ids use dashes, not dots).


## License

MIT — see [LICENSE](LICENSE). Original Lazy AI by [@Paing](https://github.com/zinhmuepaing).
