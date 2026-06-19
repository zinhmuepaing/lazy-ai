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
only fall back to the pixel "click" below when the target is genuinely NOT in the UI ELEMENTS list.

each <action> is one of:
- {"type":"launch","app":"apple music"}             open/launch an app by its NAME (e.g. "notepad","word","apple music","spotify","microsoft teams","outlook"). works for normal AND Microsoft Store apps. this is THE way to open any app.
- {"type":"press","keys":"ctrl+l"}                  press a key or combo. keys = a single key ("enter","tab","esc","a","/") or a combo with ctrl/alt/shift ("ctrl+l","ctrl+shift+p","alt+f4").
- {"type":"text","text":"..."}                      type text into the focused field (via paste — any length, any characters).
- {"type":"wait","ms":1500}                          pause for the UI to catch up. ALWAYS wait after launching an app (apps take ~1–2s to open) or opening a menu/page.
- {"type":"scroll","x":640,"y":430,"amount":-600}   LAST RESORT. scroll at a pixel point; amount NEGATIVE = down, POSITIVE = up.
- {"type":"click","x":512,"y":360}          LAST RESORT. left-click a pixel point — only when there is NO keyboard way and the target is VISIBLE now.
- {"type":"doubleclick","x":..,"y":..} / {"type":"rightclick","x":..,"y":..}   LAST RESORT.

COORDINATES ARE PIXELS of the screenshot you are given (top-left is 0,0). x = pixels from the LEFT edge, y = pixels from the TOP. give INTEGERS at the exact CENTER of the target. the user message states the exact image size; x must be 0–width and y 0–height. read the position carefully off the image, as if you were clicking it yourself — aim dead-center on the control.

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
- SEARCH BOX vs MESSAGE BOX (this caused the wrong-field bug): chat apps (Teams, Outlook, Slack) have a SEARCH box at the TOP of the window AND a separate MESSAGE/compose box at the BOTTOM — BOTH are [editable]. To SEND A MESSAGE you MUST ui_type into the element whose NAME is the compose field (its name reads like "Type a message", "Write a message", "Compose", "Reply", "Message") and you must NEVER type the message into an element named "Search", "Find" or "Search box". Read each [editable] element's name and pick by name. Use the SEARCH box only to look up a person/thing — never to send the message.
- DON'T REPEAT yourself. your previous turns are in the conversation. before acting, read the CURRENT screen and check what is already done: if your text is already in the field, do NOT type it again — just send it (e.g. press enter / the Send button). if the goal is already achieved (e.g. your message now appears in the conversation), return "actions":[] with "done":true. typing the same text twice, or re-doing a finished step, is a bug.
- when sending a message, do it in ONE turn: ui_type the message INTO the [editable] field, then send (ui_invoke the Send button, or press enter), then "done":true — so you don't loop.
- to choose a SEARCH RESULT, use {"type":"ui_invoke","ref":N} on the result's element (the row with the right name/label) — not a filter chip/tab, and not a blind "down"+"enter" (in many apps that lands on a chip above the results).
- search for ONE thing at a time (the name only), then LOOK before acting.
- be FAST: batch as much as is SAFE in each turn; only stop to LOOK when the next step truly depends on what appears. keep waits tight — ~2000ms after launching an app, ~800–1200ms after an in-app action; don't over-wait.

recipe for "find <person/item> and <do something>" (e.g. Teams/Outlook) — aim for ~3 turns:
  turn 1 (batch open + search in ONE turn): {"done":false,"actions":[{"type":"launch","app":"microsoft teams"},{"type":"wait","ms":2000},{"type":"press","keys":"ctrl+e"},{"type":"text","text":"<name only>"},{"type":"wait","ms":1200}]} → LOOK at the results
  turn 2 (select): prefer {"type":"ui_invoke","ref":N} on the contact's element (the "list item"/"tree item" with the person's name — NOT the search box or a filter chip); fall back to a pixel click only if it's not listed → "done":false → LOOK (did the chat open?)
  turn 3 (act): {"type":"ui_type","ref":N,"text":"<message>"} into the message-box element, then {"type":"ui_invoke","ref":M} on the Send button (or {"type":"press","keys":"enter"}) → "done":true

- "click"/"scroll" coordinates are integer PIXELS of the CURRENT screenshot; precise CENTER of the target; only for things visible NOW.
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

the command may come from imperfect speech-to-text (homophones, brand/app names, dropped small words) — interpret it CHARITABLY.

OUTPUT BUDGET (important): your entire reply must be ONE small JSON object and nothing else — no preamble, no reasoning, no markdown fences, no text outside the JSON. keep "say" to ≤ ~8 words. emit only the actions needed for THIS turn (you'll get more turns). a short reply avoids being cut off.`;

const VALID_TYPES = new Set([
  "ui_invoke", "ui_click", "ui_type", // Stage 5.4 — act on real UI elements by ref
  "launch", "press", "text", "wait", "scroll", "click", "doubleclick", "rightclick",
]);

// Phase 1 — UIA pruning (space-complexity fix). A raw UIA dump of an app like
// Teams is hundreds of elements: every chat bubble, avatar, timestamp and layout
// group. That bloat is the *disease* behind the truncation — it forces Sonnet
// into heavy adaptive thinking and burns the 1024-token budget mid-JSON. Salvaging
// the truncated tail only treated the symptom; pruning removes the cause.
//
// Keep ONLY elements the model can actually act on: anything Invokable (buttons,
// links, selectable rows) or with a Value pattern (text fields), plus controls
// whose type is clearly interactive (edit / button / combo box). Static text
// (chat bubbles, labels, timestamps) and containers have none of these and are
// dropped. `idx` is preserved, so refs the model returns still resolve against
// the FULL element list in main.js — pruning changes only what the LLM sees.
function pruneElements(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.filter((e) => {
    if (!e) return false;
    if (e.invoke || e.value) return true; // actionable or editable → keep
    return /edit|button|combo/i.test(String(e.type || "")); // interactive type → keep
  });
}

// Render the UIA element list for the prompt. `elements` come from win-automation
// queryUiElements (idx,name,type,invoke,value). Cap name length to keep it compact.
function formatElements(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  const lines = elements.map((e) => {
    const name = String(e.name || "").replace(/\s+/g, " ").slice(0, 40);
    const tags = `${e.invoke ? " [invoke]" : ""}${e.value ? " [editable]" : ""}`;
    return `${e.idx}: ${e.type || "control"} "${name}"${tags}`;
  });
  return (
    "\n\nUI ELEMENTS on screen (use ui_invoke / ui_type / ui_click with the ref number; " +
    "if your target isn't here, fall back to a pixel click):\n" +
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

// Salvage a usable JSON object from a TRUNCATED reply (the model hit max_tokens
// mid-output — common on heavy turns with a large UIA list + adaptive thinking).
// Walks from the first "{", tracking string/escape state and the bracket stack,
// then closes any open string and brackets and strips a dangling comma / "key":.
// Returns { json, repaired } or null. `repaired:true` flags that the tail was
// completed, so the caller can drop the (suspect) last action.
function salvageJson(text) {
  const start = (text || "").indexOf("{");
  if (start < 0) return null;
  const s = text.slice(start);
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = inStr; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = s;
  const stringCut = inStr; // a string value was cut mid-way → its last action is suspect
  if (inStr) out += '"'; // close the cut-off string
  // Strip a dangling tail: trailing commas, or a "key": with no value yet.
  let prev;
  do {
    prev = out;
    out = out.replace(/[\s,]+$/, "");
    out = out.replace(/"[^"]*"\s*:\s*$/, "");
  } while (out !== prev);
  out = out.replace(/[\s,]+$/, "");
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return { json: out, stringCut };
}

// Coerce a coordinate to a safe non-negative integer pixel (the model returns
// pixels in the screenshot frame now; main.js scales them to the physical screen).
function toPx(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
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
        out.push({ type: "scroll", x: toPx(a.x), y: toPx(a.y), amount: Number(a.amount) || 0 });
        break;
      case "click":
      case "doubleclick":
      case "rightclick":
        out.push({ type: a.type, x: toPx(a.x), y: toPx(a.y) });
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

// Parse the model's reply into a plan { done, say, actions:[…] }. Tolerates code
// fences, prose around the JSON, AND truncation (recovers the complete actions
// from a cut-off reply instead of discarding everything).
function parsePlan(text) {
  const cleaned = (text || "").replace(/```json/gi, "```").replace(/```/g, "").trim();

  // Fast path: a clean, complete JSON object.
  let data = tryParseJson(cleaned);

  // Otherwise salvage from the first "{": repairs truncation and ignores prose.
  let stringCut = false;
  if (!data || typeof data !== "object") {
    const sal = salvageJson(cleaned);
    if (sal) {
      data = tryParseJson(sal.json);
      stringCut = sal.stringCut;
    }
  }

  if (!data || typeof data !== "object") {
    return { done: true, say: "I couldn't work out a safe plan for that.", actions: [] };
  }

  // If a string value was truncated, the LAST action straddled the cut and may be
  // partial — drop it and let the loop re-plan the remainder. (When only brackets
  // were closed, the actions before the cut were complete, so keep them all.)
  if (stringCut && Array.isArray(data.actions) && data.actions.length) data.actions.pop();

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
  // State the EXACT image size so the model's pixel coords land in the same frame
  // main.js maps back to the screen. This is the fix that made Screen Teacher
  // accurate on Sonnet — the model was trained to emit pixels, not percentages.
  const sizeNote =
    imageWidth && imageHeight
      ? `The screenshot is exactly ${imageWidth}×${imageHeight} pixels (top-left is 0,0). For any click/scroll fallback, give integer x,y pixels at the exact CENTER of the target: x in 0–${imageWidth}, y in 0–${imageHeight}.`
      : "For any click/scroll fallback, give integer x,y pixels at the exact CENTER of the target.";
  const dims =
    "\n\n" + sizeNote +
    formatElements(pruneElements(elements)) + // Phase 1 — only show actionable controls
    // Phase 2 — last-line JSON discipline (prefill substitute; Sonnet 4.6 rejects
    // assistant prefill). Ending the turn here forces the reply to be JSON-only.
    '\n\nRespond with ONLY the JSON object and nothing else — no thinking, no preamble, no markdown. Your first character must be "{".';

  // Text BEFORE image — per Anthropic's computer-use guidance this lets the model
  // read the goal/elements first and improves click accuracy.
  const userTurn = {
    role: "user",
    content: [
      { type: "text", text: base + dims },
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
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
        // Phase 2 — token discipline WITHOUT prefill. Sonnet 4.6 rejects assistant
        // message prefill ("the conversation must end with a user message"), so we
        // can't seed a "{". Instead we (a) keep the budget from being wasted on a
        // bloated element list via Phase-1 pruning, and (b) end the user turn with a
        // hard "respond with ONLY the JSON object, starting with {" instruction (see
        // `dims`), which is where this model takes its strongest formatting cue. The
        // salvage parser stays as a safety net for the rare truncated tail.
        messages: [...history, userTurn],
      }),
    });
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${await res.text()}` };
    const data = await res.json();
    // Take the TEXT block(s) — not content[0], which can be a "thinking" block
    // (adaptive thinking) and would leave us with no JSON.
    const text = (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
    const plan = parsePlan(text); // tolerant of truncation (recovers complete actions)
    // The rare unrecoverable case (no JSON at all — e.g. the whole budget went to a
    // thinking block); log it precisely instead of the vague fallback.
    if (!text.includes("{")) {
      console.warn(`[lazy-ai] control: no JSON in reply (stop_reason=${data.stop_reason}, textLen=${text.length})`);
      if (data.stop_reason === "max_tokens") plan.say = "The reply was cut off — try again.";
    }
    return { ok: true, plan, raw: text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { planActions, parsePlan, sanitizeActions, pruneElements, DEFAULT_CONTROL_MODEL };
