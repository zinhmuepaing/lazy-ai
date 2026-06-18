// Lazy AI — Screen Teacher engine (Stage 4).
//
// Takes a screenshot (base64 PNG) plus a question, asks Claude (vision) to
// answer AND return structured drawing instructions, and parses those
// instructions out for the overlay canvas to render.
//
// Model choice is a quality/cost tradeoff. Opus 4.8 ($5/$25 per MTok) has
// high-resolution vision with pixel-accurate coordinates (Opus 4.7+). Sonnet
// 4.6 ($3/$15) is cheaper but is prior-generation vision, so the API downscales
// big screenshots to ~1568px — which is why main.js caps the screenshot to that
// long edge before sending, keeping the AI's coordinates 1:1 with the canvas.
//
// Key is read from process.env (loaded by main.js, overridable in Settings).

const SCREEN_TEACHER_MODEL = "claude-opus-4-7";

// Opus 4.7/4.8 have high-resolution vision (good to ~2576px on the long edge)
// with pixel-accurate coordinates — give them the detail so annotations land
// precisely. Sonnet/older vision tops out near 1568px; above that the API
// downscales and coordinates drift. main.js caps the screenshot to this.
const MAX_IMAGE_LONG_EDGE = /opus-4-(7|8)/.test(SCREEN_TEACHER_MODEL) ? 2560 : 1568;

const SYSTEM_PROMPT = `you are Screen Teacher, an assistant that looks at a screenshot of the user's screen and teaches them like a narrated, animated explainer — and, for step-by-step tasks, GUIDES them one action at a time, following along as they act.

you reply with ONLY this JSON object and NOTHING else:

{"done": true|false, "steps":[
  {"say":"one short spoken sentence","draw":[ <shape>, ... ]},
  {"say":"the next sentence","draw":[ <shape> ]}
]}

"steps" is an ordered list of narration moments. "say" is the sentence the narrator speaks at that moment. "draw" is ONLY the annotation(s) that should appear WHILE that sentence is spoken — normally exactly ONE shape highlighting the exact thing the sentence is about. they play in order: as each sentence is spoken, only that step's shape is shown and highlighted, then it clears and the next step's shape appears. so DON'T dump the whole drawing at once — spread the shapes across the steps, one idea per step.

"done" controls whether you are waiting to see the user act:
- set "done": false when the user must DO something (click / open / type / scroll) before they can progress, and you want to see the RESULT on the next screen before guiding further. you will then automatically be shown the new screen and asked to continue.
- set "done": true when the task is fully complete, OR when the request was just an explanation with no further action needed.

INTERACTIVE GUIDANCE — when the user asks "how do I…" or anything that takes several actions:
- guide exactly ONE action at a time, using ONLY what is actually visible on the CURRENT screen. do NOT point at or describe things that are not on screen yet (e.g. an item inside a menu/dropdown that hasn't been opened) — you will see them after the user opens it.
- the "say" tells them precisely what to do next ("Click the green Code button"), and "draw" points at that exact control. for action steps keep "say" to ONE short imperative sentence (~12 words) and emit just ONE step — be fast and concise, not chatty.
- set "done": false on each action step so you can react to what happens; set "done": true only once the goal is achieved on screen.
- on later turns you'll be told the user has acted and shown the updated screen — re-read it and guide the next single step (or finish).

supported shapes (coordinates are PIXELS of the screenshot you were given, origin (0,0) at the TOP-LEFT):
- {"shape":"arrow","from":[x,y],"to":[x,y],"label":"short text"}   point at something; label optional
- {"shape":"box","x":x,"y":y,"w":width,"h":height,"label":"short text"}   highlight a region; label optional
- {"shape":"circle","x":cx,"y":cy,"r":radius,"label":"short text"}   circle a thing; label optional
- {"shape":"line","from":[x,y],"to":[x,y]}   a plain line
- {"shape":"label","x":x,"y":y,"text":"short text"}   just text at a point

rules:
- the question may come from imperfect speech-to-text and may contain transcription errors — homophones, brand names, or wrong/dropped small words (e.g. "Cloud" likely means "Claude"; "this what page" likely means "this web page"). interpret it CHARITABLY using what's actually visible on screen; answer the question the user clearly meant.
- the "say" sentence and its "draw" shape MUST match: whatever the sentence names is exactly what that step draws and where.
- point at things that are ACTUALLY visible in the screenshot, at their real pixel locations.
- BE PRECISE with coordinates. read them carefully off the image: an arrow's "to" point must land exactly ON the target element; a box must tightly enclose it (not float beside or below it); a circle must be centered on it. when unsure, prefer an arrow pointing at the element over a box around an approximate region.
- keep each "say" to one natural spoken sentence; keep labels to a few words. for a pure explanation you may use several steps; for a task, usually ONE action step per turn.
- if the request needs no drawing at all, return a single step with the answer in "say" and "draw":[].
- output ONLY the JSON object. no preamble, no markdown fences, no text outside the JSON.`;

// Pull every [DRAW:{...}] block out of the model's reply and parse each as JSON.
// The remaining text (with the DRAW lines removed) is the spoken explanation.
// Kept as a graceful fallback if the model ever ignores the stepped JSON format.
function parseDrawInstructions(text) {
  const instructions = [];
  const drawPattern = /\[DRAW:(\{.*?\})\]/g; // JSON is single-line; arrays use [], so non-greedy {} is safe
  let match;
  while ((match = drawPattern.exec(text)) !== null) {
    try {
      instructions.push(JSON.parse(match[1]));
    } catch {
      // skip a malformed instruction rather than failing the whole answer
    }
  }
  const explanation = text.replace(drawPattern, "").replace(/\n{2,}/g, "\n").trim();
  return { instructions, explanation };
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Parse the model's reply into an ordered list of narration steps:
//   [{ say: string, draw: [shape, ...] }, ...]
// Tolerates stray prose / code fences around the JSON. Falls back to the legacy
// [DRAW:...]+explanation format (as a single un-synced step) if no JSON is found,
// so a malformed answer still shows *something*.
function parseSteps(text) {
  const cleaned = (text || "").replace(/```json/gi, "```").replace(/```/g, "").trim();

  let data = tryParseJson(cleaned);
  if (!data) {
    // grab the outermost {...} (or [...]) if the model wrapped it in prose
    const obj = cleaned.match(/\{[\s\S]*\}/);
    const arr = cleaned.match(/\[[\s\S]*\]/);
    data = (obj && tryParseJson(obj[0])) || (arr && tryParseJson(arr[0])) || null;
  }

  let rawSteps = null;
  if (Array.isArray(data)) rawSteps = data;
  else if (data && Array.isArray(data.steps)) rawSteps = data.steps;

  // "done" tells the guide loop whether to keep watching for the user to act.
  // Default true (stop) so a model that omits it never traps us in a loop.
  const done = data && !Array.isArray(data) && typeof data.done === "boolean" ? data.done : true;

  if (rawSteps) {
    const steps = rawSteps
      .map((s) => ({
        say: String(s?.say ?? "").trim(),
        draw: Array.isArray(s?.draw) ? s.draw.filter((d) => d && typeof d === "object") : [],
      }))
      .filter((s) => s.say || s.draw.length);
    if (steps.length) {
      const explanation = steps.map((s) => s.say).filter(Boolean).join(" ");
      return { steps, explanation, done };
    }
  }

  // Fallback: legacy [DRAW]+prose → one step with everything (no sync).
  const legacy = parseDrawInstructions(text);
  const say = legacy.explanation || "";
  return {
    steps: [{ say, draw: legacy.instructions }],
    explanation: say,
    done: true,
  };
}

// Ask the vision model about the current screen.
//   question   — the user's goal (used as the prompt on the first turn).
//   turnText   — overrides the prompt text on later guide turns ("the user acted…").
//   history    — prior turns (Anthropic message objects, text-only) for guide mode.
// Returns { ok, steps, explanation, done, raw }. `done:false` means the guide
// loop should watch for the user to act, then call again with the new screen.
async function askAboutScreen({ imageBase64, mediaType = "image/png", question, imageWidth, imageHeight, history = [], turnText = null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY is missing — set it in Settings or .env" };

  // Anchor the model's coordinate frame by stating the exact image size, so its
  // pixel estimates are in the same space the overlay canvas renders.
  const base = turnText ?? ((question || "").trim() || "Explain what's on my screen and point out the key parts.");
  const dims =
    imageWidth && imageHeight
      ? `\n\nThe screenshot is exactly ${imageWidth}×${imageHeight} pixels (top-left is 0,0). Every coordinate you output must be an integer in that range: x in 0–${imageWidth}, y in 0–${imageHeight}.`
      : "";
  const userText = base + dims;

  const userTurn = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: userText },
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
        model: SCREEN_TEACHER_MODEL,
        max_tokens: 2048,
        // Cache the (large, static) system prompt so multi-turn guide sessions
        // don't reprocess it each step — lowers time-to-first-token on turns 2+.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [...history, userTurn],
      }),
    });

    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${await res.text()}` };
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() ?? "";
    const { steps, explanation, done } = parseSteps(text);
    return { ok: true, steps, explanation, done, raw: text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Voice-query cleanup. Whisper mishears homophones and drops small words, so we
// run the raw transcript through a fast, cheap model that fixes likely
// speech-to-text errors WITHOUT changing the meaning or expanding the question.
// Falls back to the raw text if there's no key or the call fails.
// ---------------------------------------------------------------------------
const QUERY_CLEANUP_MODEL = "claude-haiku-4-5";

const QUERY_CLEANUP_PROMPT = `you fix raw speech-to-text transcripts of a short spoken question the user asked about their computer screen.

correct LIKELY transcription errors only:
- homophones and brand/app names (e.g. "Cloud" or "clawed" → "Claude", "fl studio" → "FL Studio").
- wrong or dropped small words (e.g. "this what page" → "this web page", "i cant see" → "I can't see").
- capitalization and punctuation.

keep it a short, natural question with the SAME meaning and roughly the same length. do NOT add detail, do NOT restructure, do NOT answer it. output ONLY the corrected question — nothing else.`;

async function cleanVoiceQuery(rawText) {
  const text = (rawText || "").trim();
  if (!text) return text;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return text; // no key → just use the raw transcript

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: QUERY_CLEANUP_MODEL,
        max_tokens: 256,
        system: QUERY_CLEANUP_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return text;
    const data = await res.json();
    const cleaned = data.content?.[0]?.text?.trim();
    return cleaned || text;
  } catch {
    return text; // network/parse failure → fall back to raw
  }
}

module.exports = { askAboutScreen, cleanVoiceQuery, parseSteps, parseDrawInstructions, SCREEN_TEACHER_MODEL, MAX_IMAGE_LONG_EDGE };
