<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:ff7a52,100:ec4d25&height=190&section=header&text=Lizzie&fontSize=64&fontColor=ffffff&fontAlignY=36&desc=Always-on%20AI%20overlay%20for%20Windows&descSize=18&descAlignY=60&animation=fadeIn" alt="Lizzie" width="100%" />

An always-on AI overlay companion for **Windows** — summoned by a global hotkey to polish text,
explain what's on your screen, or carry out tasks for you, without leaving the app you're in.

![Electron](https://img.shields.io/badge/Electron-2B2E3A?logo=electron&logoColor=9FEAF9)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![PowerShell](https://img.shields.io/badge/Win32-UIA%20automation-5391FE?logo=powershell&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper-ONNX%20Runtime-005CED?logo=onnx&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Anthropic-D97757?logo=anthropic&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

</div>

> [!NOTE]
> This is the **private source repository**. The public download and landing page live in a
> separate repo: [zinhmuepaing/lizzie](https://github.com/zinhmuepaing/lizzie).

## 🪟 The three pillars

All three are built and functional.

| | Pillar | Hotkey | What it does |
|---|--------|--------|--------------|
| ✍️ | **Prompt Polisher** | `Ctrl + Shift + Space` | Grab the current selection, rewrite it with the chosen model, and paste it back in place. |
| 🎓 | **DeskTutor** | `Ctrl + Shift + S` | Screenshot + a voice/text question. A vision model answers with arrows and notes drawn on screen, narrated aloud by streamed Edge-TTS. |
| 🤖 | **DeskPilot** | `Ctrl + Shift + A` | Screenshot + a UI Automation element list + a command. The model returns a batched plan of UIA / keyboard / vision actions that run in one PowerShell process. |

## 🏗️ Architecture: "two faces, one brain"

- **`lazy-ai/`** — the **brain**. An Electron tray app that holds the API keys, runs the polish
  engine, hosts a local HTTP server on `http://localhost:8788`, and owns the DeskTutor and
  DeskPilot loops. Summoned by a hotkey as a frameless overlay; grabs the selection and pastes
  the result back.
- **`lazy-ai-extension/`** — the **in-tab face**. A Manifest V3 browser extension: a floating
  button and in-page panel that replaces text in place. It holds **no keys and no AI logic** —
  it only calls `http://localhost:8788/polish`.

One brain means keys live in exactly one place and logic is never duplicated. `/polish` is a
stable contract (the same shape a future hosted worker would expose), so moving the backend
later changes only a URL.

```
lazy-ai/             Electron desktop app  (keys, engines, local server, overlays)
   ^   http://localhost:8788/polish
   |
lazy-ai-extension/   MV3 extension  (floating button + panel, no keys)
```

## 🗂️ Repository layout

<details>
<summary><strong>📁 lazy-ai/src/ — file map</strong></summary>

| File | Purpose |
|------|---------|
| `main.js` | Electron main process: keys, IPC, tray, global hotkeys, the summon popup, settings/overlay windows, selection grab/paste, and the DeskTutor + DeskPilot loops. |
| `polish-engine.js` | Shared polish engine: the model registry, provider calls (Anthropic / Google / OpenAI), `polish(payload)`, and file-text extraction. |
| `local-server.js` | HTTP server on `localhost:8788`: `POST /polish`, `GET /health`, `GET /`, and `GET /tts` (streams Edge-TTS audio). Binds to `127.0.0.1`. |
| `screen-control.js` | DeskPilot engine: turns a screenshot, element list, and command into a batched action plan. |
| `screen-teacher.js` | DeskTutor engine: turns a screenshot and question into narrated steps with on-screen annotations. |
| `win-automation.js` + `*.ps1` | PowerShell + Win32 automation (no native dependency): focus, click, type, scroll, drag, UIA query, foreground window, and OCR. |
| `overlay.*` | The transparent, always-on-top annotation overlay and control bar; streams narration audio and runs push-to-talk. |
| `voice-engine.js` | Local speech-to-text via Transformers.js, using a bundled offline Whisper model. |
| `tts-engine.js` | Streaming Edge-TTS engine (the "Ava" voice) that feeds `/tts`. |
| `settings-store.js` / `settings.*` | The Settings window and encrypted key storage. |
| `preload.js` | The `contextBridge` surface; no Node and no keys reach the renderer. |
| `index.html` / `renderer.js` / `styles.css` | The summon-popup UI. |

</details>

<details>
<summary><strong>📁 lazy-ai-extension/ — file map</strong></summary>

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3; `host_permissions` for `localhost:8788`; a content script on all URLs. |
| `background.js` | Service worker that relays `polish` requests to `localhost:8788/polish`. |
| `content.js` / `content.css` | Floating button + panel; reads the focused field and replaces text in place. |

</details>

## 🧰 Tech stack

- **Electron** — tray app, frameless overlay windows, and global shortcuts.
- **Local speech-to-text** — OpenAI Whisper (`whisper-tiny.en`) via **Transformers.js** on the **ONNX Runtime**, bundled offline so nothing is fetched at runtime.
- **Streaming text-to-speech** — **Edge-TTS** (`msedge-tts`, the "Ava" neural voice), with the browser `speechSynthesis` as an offline fallback.
- **AI providers** — Anthropic Claude (default), Google Gemini, and OpenAI GPT.
- **Windows automation** — PowerShell with the Win32 UI Automation API and SendKeys, plus Windows OCR for grounding. No compiled native dependency.
- **Secure storage** — Windows DPAPI via Electron `safeStorage`.
- **Packaging** — electron-builder (NSIS one-click installer).
- **File extraction** — `mammoth` (.docx) and `pdf-parse` (.pdf) for attachments.

## ⚡ Setup and run

> [!IMPORTANT]
> Prerequisites: Windows 10/11 (64-bit), Node.js 18+ (Electron 33 ships Node 20), and at least
> one provider API key (Anthropic recommended).

```powershell
npm install --prefix lazy-ai            # install dependencies (first time only)
npm run setup:models --prefix lazy-ai   # bundle the offline Whisper model into assets/models/ (gitignored)
npm start --prefix lazy-ai              # launch the app and the local server on :8788
```

Provide a key either way:

- In-app **Settings** (recommended): right-click the tray icon, open Settings, paste your key.
  It's encrypted with DPAPI and unlocks immediately, no restart.
- Or copy `lazy-ai/.env.example` to `lazy-ai/.env` and paste your keys there.

The app starts **in the tray with no window** — that's expected. Summon it with the hotkeys above.

<details>
<summary><strong>🧩 Load the browser extension (optional)</strong></summary>

With the desktop app running:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `lazy-ai-extension` folder.
4. On any page with a text field, click the floating button, review the polished prompt, and replace it.

</details>

## 📦 Build the installer

```powershell
npm run dist --prefix lazy-ai           # produces lazy-ai/dist/LizzieSetup.exe (NSIS one-click)
```

`dist` runs the model bundler and the icon generator, then electron-builder. The bundled Whisper
model and the `.ps1` scripts are kept outside the asar archive (`asarUnpack`) so an external
PowerShell process can read them. The build config excludes `.env*` and other secrets, so the
installer ships no keys.

> [!WARNING]
> electron-builder's code-signing tool needs the symlink-create privilege. Enable Windows
> **Developer Mode** (or run the shell as Administrator) once, or the build fails while
> unpacking it with *"Cannot create symbolic link."*

## ⚙️ Configuration

| Provider | Environment variable | Settings UI |
|----------|----------------------|-------------|
| Anthropic | `ANTHROPIC_API_KEY` | yes |
| Google | `GEMINI_API_KEY` | yes |
| OpenAI | `OPENAI_API_KEY` | yes |

Keys entered in Settings are encrypted at rest (DPAPI), injected into `process.env` at runtime,
and never returned to the renderer. A stored key takes precedence over `.env`, and `.env` is
optional.

### Prompt Polisher models

| UI label | API model id | Provider |
|----------|--------------|----------|
| Claude Haiku 4.5 (default) | `claude-haiku-4-5` | Anthropic |
| Gemini 3.1 Flash Lite | `gemini-3.1-flash-lite` | Google |
| GPT-5.4 Nano | `gpt-5.4-nano` | OpenAI |

Model ids live in `lazy-ai/src/polish-engine.js`, and provider ids use dashes, not dots.
DeskPilot defaults to Claude Sonnet 4.6; the DeskTutor vision model is selectable.

## 🔌 The `/polish` contract

The desktop server and the extension share one stable contract.

<details>
<summary><strong>Request / response shape</strong></summary>

Request — `POST http://localhost:8788/polish`

```json
{ "modelId": "claude-haiku-4-5", "promptText": "...", "context": "optional", "fileName": "optional", "fileText": "optional" }
```

Response

```json
{ "ok": true, "text": "polished result" }
```

or

```json
{ "ok": false, "error": "message" }
```

Other endpoints: `GET /health`, `GET /` (a small status page), and `GET /tts?text=...&rate=...`
(streams Edge-TTS audio for narration).

</details>

## 🛡️ Security model

- API keys live only on the local machine, encrypted with DPAPI. They're never bundled, logged, or sent anywhere except directly to the chosen provider.
- The local server binds to `127.0.0.1` only.
- Microphone audio is transcribed on-device by the bundled Whisper model and never leaves the machine.
- The browser extension holds no secrets and no AI logic.

## 📄 License

Released under the MIT License — see [LICENSE](LICENSE). Created by [Zin Hmue Paing](https://github.com/zinhmuepaing).

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:ff7a52,100:ec4d25&height=110&section=footer" alt="" width="100%" />
</div>
