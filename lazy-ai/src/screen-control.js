// Lazy AI — Screen Control engine (Stage 5, fast path 5.3).
//
// Turns a command + screenshot into a PLAN: an ordered batch of input actions to
// run in one shot. Keyboard-first (launch apps, press shortcuts, type) with a
// VISION fallback (click/scroll at screenshot pixels) only when something must be
// clicked and is visible. Batching collapses a multi-step task into ONE model
// call + ONE PowerShell run, instead of a vision round-trip per action.
//
// Defaults to Claude Sonnet 4.6 — fast/cheap and plenty for action planning
// (keyboard actions don't need pixel-precise vision). Key from process.env.

const DEFAULT_CONTROL_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `you are Screen Control. you carry out a user's command on a Windows PC by producing a PLAN of input actions.

THE GOLDEN RULE: KEYBOARD ONLY, unless a mouse click is the ONLY possible way.
the mouse (click/scroll) is a LAST RESORT. assume every standard task — opening an app, focusing a search box, typing, submitting, navigating — has a keyboard way, and use it. do NOT look for buttons to click when a shortcut or "launch" will do. a plan that opens an app and types something should contain ZERO clicks.

reply with ONLY this JSON object and NOTHING else:
{"done":true|false,"say":"one short sentence describing what you're doing","actions":[ <action>, ... ]}

each <action> is one of:
- {"type":"launch","app":"apple music"}             open/launch an app by its NAME (e.g. "notepad","word","apple music","spotify","microsoft teams","outlook"). works for normal AND Microsoft Store apps. this is THE way to open any app.
- {"type":"press","keys":"ctrl+l"}                  press a key or combo. keys = a single key ("enter","tab","esc","a","/") or a combo with ctrl/alt/shift ("ctrl+l","ctrl+shift+p","alt+f4").
- {"type":"text","text":"..."}                      type text into the focused field (via paste — any length, any characters).
- {"type":"wait","ms":1500}                          pause for the UI to catch up. ALWAYS wait after launching an app (apps take ~1–2s to open) or opening a menu/page.
- {"type":"scroll","xPct":50.0,"yPct":60.0,"amount":-600}   LAST RESORT. scroll at a point; amount NEGATIVE = down, POSITIVE = up.
- {"type":"click","xPct":45.5,"yPct":50.0}          LAST RESORT. left-click a point — only when there is NO keyboard way and the target is VISIBLE now.
- {"type":"doubleclick","xPct":..,"yPct":..} / {"type":"rightclick","xPct":..,"yPct":..}   LAST RESORT.

COORDINATES ARE PERCENTAGES, NOT PIXELS. xPct = horizontal position as a percentage of the screen WIDTH from the left edge (0 = far left, 100 = far right). yPct = vertical position as a percentage of the screen HEIGHT from the top (0 = top, 100 = bottom). use one decimal place. aim for the exact CENTER of the target. example: a button in the middle of the screen is xPct 50, yPct 50; one in the top-right is around xPct 92, yPct 8.

NEVER use click/scroll for any of these — there is always a keyboard way:
- opening an app  → use "launch" (never click a desktop/taskbar/Start icon).
- focusing a search or address bar → press its shortcut (browsers/Spotify "ctrl+l", many apps "ctrl+f" or "ctrl+k", then "text").
- typing or submitting → "text" then "press enter".
- closing/menus with known shortcuts → "press" (e.g. "alt+f4", "ctrl+w", "escape").

WHEN TO BATCH vs WHEN TO STOP AND LOOK:
- BATCH everything and set "done":true ONLY when the whole task is deterministic and needs NO intermediate result — e.g. open an app and type into its main editing area (Notepad, Word, OneNote, a new doc). that is the fast path.
- STOP and set "done":false whenever the NEXT step depends on something you can't see yet — search results, a specific item/contact in a list, or WHETHER the right field is focused. emit only the steps you're sure of, then "done":false; you'll get a fresh screenshot to continue from.
- you will usually NOT finish a "find X and do Y" task in one turn — that is expected. take it a few steps at a time, looking between them.

CRITICAL accuracy rules (these caused real failures):
- NEVER type a value until you can SEE the correct field is focused. don't type the message into the search box.
- to choose a SEARCH RESULT, CLICK the specific result you can see — the row with the right name/photo/label. MANY apps (e.g. Teams) show filter chips/tabs ("from:…", Messages, Files) ABOVE the real results, so pressing "down" lands on a CHIP, not the person — do NOT blindly arrow there (it causes a wrong selection and a retry loop). use "down"+"enter" only for a plain list with NO chips/tabs above it.
- after you open a chat/conversation/compose window, its text input is ALREADY focused — just use "text" to type. do NOT click the input field (a stray click lands in the wrong place and loops). only click an input if you can SEE it is clearly not focused.
- search for ONE thing at a time (the name only), then LOOK before acting.
- be FAST: batch as much as is SAFE in each turn; only stop to LOOK when the next step truly depends on what appears. keep waits tight — ~2000ms after launching an app, ~800–1200ms after an in-app action; don't over-wait.

recipe for "find <person/item> and <do something>" (e.g. Teams/Outlook) — aim for ~3 turns:
  turn 1 (batch open + search in ONE turn): {"done":false,"actions":[{"type":"launch","app":"microsoft teams"},{"type":"wait","ms":2000},{"type":"press","keys":"ctrl+e"},{"type":"text","text":"<name only>"},{"type":"wait","ms":1200}]} → LOOK at the results
  turn 2 (select): {"type":"click","xPct":..,"yPct":..} on the correct result row you can SEE (the person's name/photo, NOT a filter chip) → "done":false → LOOK (did the chat open?)
  turn 3 (act): the message box is now focused — {"type":"text","text":"<message>"} then {"type":"press","keys":"enter"} → "done":true (do NOT click the message box first)

- "click"/"scroll" coordinates are PIXELS of the CURRENT screenshot; precise CENTER of the target; only for things visible NOW.
- if nothing is possible/safe, return "actions":[] with "done":true and explain in "say".

worked examples:

SIMPLE, deterministic → batch + done:true (ZERO clicks):
command "open Notepad and type a haiku about winter" →
{"done":true,"say":"Opening Notepad and typing a winter haiku","actions":[
{"type":"launch","app":"notepad"},
{"type":"wait","ms":1500},
{"type":"text","text":"Silent snow descends\\nBlanketing the quiet world\\nWinter holds its breath"}
]}

UNCERTAIN multi-step → batch what's safe, then stop to look:
command "open Microsoft Teams and message Bhone Min Thant" → FIRST turn (open + search together):
{"done":false,"say":"Opening Teams and searching for Bhone Min Thant","actions":[
{"type":"launch","app":"microsoft teams"},
{"type":"wait","ms":2000},
{"type":"press","keys":"ctrl+e"},
{"type":"text","text":"Bhone Min Thant"},
{"type":"wait","ms":1200}
]}
(then LOOK; next turn CLICK his contact row in the results; the turn after, type the message + enter)

the command may come from imperfect speech-to-text (homophones, brand/app names, dropped small words) — interpret it CHARITABLY. output ONLY the JSON object. no preamble, no markdown fences, no text outside the JSON.`;

const VALID_TYPES = new Set(["launch", "press", "text", "wait", "scroll", "click", "doubleclick", "rightclick"]);

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Clamp a percentage (0–100) to a safe number; accepts "45.5%" or 45.5.
function clampPct(v) {
  const n = Number(String(v ?? "").replace("%", ""));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

// Keep only well-formed actions, coercing fields to safe types. Anything unknown
// or malformed is dropped rather than executed.
function sanitizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object" || !VALID_TYPES.has(a.type)) continue;
    switch (a.type) {
      case "launch":
        if (typeof a.app === "string" && a.app.trim()) out.push({ type: "launch", app: a.app.trim() });
        break;
      case "press":
        if (typeof a.keys === "string" && a.keys.trim()) out.push({ type: "press", keys: a.keys.trim() });
        break;
      case "text":
        if (typeof a.text === "string") out.push({ type: "text", text: a.text });
        break;
      case "wait":
        out.push({ type: "wait", ms: Math.min(8000, Math.max(0, Number(a.ms) || 0)) });
        break;
      case "scroll":
        out.push({ type: "scroll", xPct: clampPct(a.xPct), yPct: clampPct(a.yPct), amount: Number(a.amount) || 0 });
        break;
      case "click":
      case "doubleclick":
      case "rightclick":
        out.push({ type: a.type, xPct: clampPct(a.xPct), yPct: clampPct(a.yPct) });
        break;
    }
  }
  return out;
}

// Parse the model's reply into a plan { done, say, actions:[…] }. Tolerates fences/prose.
function parsePlan(text) {
  const cleaned = (text || "").replace(/```json/gi, "```").replace(/```/g, "").trim();
  let data = tryParseJson(cleaned);
  if (!data) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    data = m && tryParseJson(m[0]);
  }
  if (!data || typeof data !== "object") {
    return { done: true, say: "I couldn't work out a safe plan for that.", actions: [] };
  }
  return {
    done: data.done !== false, // default true so we never loop on a malformed reply
    say: typeof data.say === "string" ? data.say : "",
    actions: sanitizeActions(data.actions),
  };
}

// Ask the model for the next plan toward the goal.
//   command  — the user's goal (prompt on the first turn).
//   turnText — overrides the prompt on later turns.
//   history  — prior turns (Anthropic message objects, text-only).
// Returns { ok, plan:{done,say,actions}, raw } or { ok:false, error }.
async function planActions({ imageBase64, mediaType = "image/png", command, imageWidth, imageHeight, model, history = [], turnText = null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY is missing — set it in Settings or .env" };
  const useModel = model || DEFAULT_CONTROL_MODEL;

  const base = turnText ?? `Goal: ${(command || "").trim()}`;
  if (!base.trim()) return { ok: false, error: "No command given." };
  // Coordinates are percentages of the screen, so they're independent of the
  // image's pixel size — no need to state dimensions.
  const dims =
    "\n\nFor any click/scroll, give the location as PERCENTAGES of the screen: xPct (0–100 from the left) and yPct (0–100 from the top), one decimal place, at the CENTER of the target.";

  const userTurn = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: base + dims },
    ],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [...history, userTurn],
      }),
    });
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${await res.text()}` };
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() ?? "";
    return { ok: true, plan: parsePlan(text), raw: text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { planActions, parsePlan, sanitizeActions, DEFAULT_CONTROL_MODEL };
