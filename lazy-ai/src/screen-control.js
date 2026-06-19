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

PREFERRED — act on real UI ELEMENTS. each turn you're given a numbered list of on-screen controls (the "UI ELEMENTS" section). when the thing you want is in that list, ALWAYS use its "ref" — this clicks/types the real control via the OS, pixel-perfect, far more reliable than guessing coordinates:
- {"type":"ui_invoke","ref":12}                     activate element 12 — best for buttons, list items, contacts, menu items, tabs (e.g. a Play button, a contact row, Send).
- {"type":"ui_type","ref":3,"text":"..."}           focus the editable element 3 and type into it — best for search boxes and message boxes ([editable] in the list).
- {"type":"ui_click","ref":12}                      plain left-click at element 12's center (use only if ui_invoke isn't right).
only fall back to the percentage "click" below when the target is genuinely NOT in the UI ELEMENTS list.

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
- opening an app  → use "launch" (never click a desktop/taskbar/Start icon). BUT if the app is ALREADY open (its window or its controls already appear in the UI ELEMENTS / screenshot), do NOT launch it again — just continue from the current state.
- focusing a search or address bar → press its shortcut (browsers/Spotify "ctrl+l", many apps "ctrl+f" or "ctrl+k", then "text").
- typing or submitting → "text" then "press enter".
- closing/menus with known shortcuts → "press" (e.g. "alt+f4", "ctrl+w", "escape").

WHEN TO BATCH vs WHEN TO STOP AND LOOK:
- BATCH everything and set "done":true ONLY when the whole task is deterministic and needs NO intermediate result — e.g. open an app and type into its main editing area (Notepad, Word, OneNote, a new doc). that is the fast path.
- STOP and set "done":false whenever the NEXT step depends on something you can't see yet — search results, a specific item/contact in a list, or WHETHER the right field is focused. emit only the steps you're sure of, then "done":false; you'll get a fresh screenshot to continue from.
- you will usually NOT finish a "find X and do Y" task in one turn — that is expected. take it a few steps at a time, looking between them.

CRITICAL accuracy rules (these caused real failures):
- ACT ONLY ON REAL CONTROLS. every action must target an actual control — a UI ELEMENTS entry (preferred) or a clearly visible, identifiable control. NEVER click or point at empty/blank space (a chat transcript area, a page background, padding). a click on blank space does nothing and just wastes a turn.
- TO ENTER TEXT, use {"type":"ui_type","ref":N} on an element marked [editable] (an edit / text box / combo box) — that IS the text field (message box, compose area, search box). ui_type focuses the real field and types, so you do NOT need a separate click, and you must NEVER click a blank region to "focus" a field. NEVER ui_type a button, tab, menu item, or icon — a magnifier/search icon or a "find" button is NOT a message box. if there is no [editable] element in the list yet (the field hasn't rendered), do NOT improvise on a button — emit a short {"type":"wait","ms":900} with "done":false and look again.
- match the field to the task: type a message into the message/compose field, a query into the search field — reason from each element's name/type, don't assume.
- DON'T REPEAT yourself. your previous turns are in the conversation. before acting, read the CURRENT screen and check what is already done: if your text is already in the field, do NOT type it again — just send it (e.g. press enter / the Send button). if the goal is already achieved (e.g. your message now appears in the conversation), return "actions":[] with "done":true. typing the same text twice, or re-doing a finished step, is a bug.
- when sending a message, do it in ONE turn: ui_type the message INTO the [editable] field, then send (ui_invoke the Send button, or press enter), then "done":true — so you don't loop.
- to choose a SEARCH RESULT, use {"type":"ui_invoke","ref":N} on the result's element (the row with the right name/label) — not a filter chip/tab, and not a blind "down"+"enter" (in many apps that lands on a chip above the results).
- search for ONE thing at a time (the name only), then LOOK before acting.
- be FAST: batch as much as is SAFE in each turn; only stop to LOOK when the next step truly depends on what appears. keep waits tight — ~2000ms after launching an app, ~800–1200ms after an in-app action; don't over-wait.

recipe for "find <person/item> and <do something>" (e.g. Teams/Outlook) — aim for ~3 turns:
  turn 1 (batch open + search in ONE turn): {"done":false,"actions":[{"type":"launch","app":"microsoft teams"},{"type":"wait","ms":2000},{"type":"press","keys":"ctrl+e"},{"type":"text","text":"<name only>"},{"type":"wait","ms":1200}]} → LOOK at the results
  turn 2 (select): prefer {"type":"ui_invoke","ref":N} on the contact's element (the "list item"/"tree item" with the person's name — NOT the search box or a filter chip); fall back to a percentage click only if it's not listed → "done":false → LOOK (did the chat open?)
  turn 3 (act): {"type":"ui_type","ref":N,"text":"<message>"} into the message-box element, then {"type":"ui_invoke","ref":M} on the Send button (or {"type":"press","keys":"enter"}) → "done":true

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

const VALID_TYPES = new Set([
  "ui_invoke", "ui_click", "ui_type", // Stage 5.4 — act on real UI elements by ref
  "launch", "press", "text", "wait", "scroll", "click", "doubleclick", "rightclick",
]);

// Render the UIA element list for the prompt. `elements` come from win-automation
// queryUiElements (idx,name,type,invoke,value). Cap name length to keep it compact.
function formatElements(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  const lines = elements.map((e) => {
    const name = String(e.name || "").replace(/\s+/g, " ").slice(0, 60);
    const tags = `${e.invoke ? " [invoke]" : ""}${e.value ? " [editable]" : ""}`;
    return `${e.idx}: ${e.type || "control"} "${name}"${tags}`;
  });
  return (
    "\n\nUI ELEMENTS on screen (use ui_invoke / ui_type / ui_click with the ref number; " +
    "if your target isn't here, fall back to a percentage click):\n" +
    lines.join("\n")
  );
}

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
      case "ui_invoke":
      case "ui_click":
        if (Number.isInteger(a.ref)) out.push({ type: a.type, ref: a.ref });
        break;
      case "ui_type":
        if (Number.isInteger(a.ref) && typeof a.text === "string") out.push({ type: "ui_type", ref: a.ref, text: a.text });
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
async function planActions({ imageBase64, mediaType = "image/png", command, imageWidth, imageHeight, model, history = [], turnText = null, elements = [] }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY is missing — set it in Settings or .env" };
  const useModel = model || DEFAULT_CONTROL_MODEL;

  const base = turnText ?? `Goal: ${(command || "").trim()}`;
  if (!base.trim()) return { ok: false, error: "No command given." };
  // Coordinates are percentages of the screen, so they're independent of the
  // image's pixel size — no need to state dimensions.
  const dims =
    "\n\nFor any percentage click/scroll fallback, give xPct (0–100 from the left) and yPct (0–100 from the top), one decimal place, at the CENTER of the target." +
    formatElements(elements);

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
    // Take the TEXT block(s) — not content[0], which can be a "thinking" block
    // (adaptive thinking) and would leave us with no JSON.
    const text = (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
    return { ok: true, plan: parsePlan(text), raw: text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { planActions, parsePlan, sanitizeActions, DEFAULT_CONTROL_MODEL };
