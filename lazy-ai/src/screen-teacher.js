// Lizzie — Screen Teacher engine (Stage 4).
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
// NOTE: drawing coordinates are ABSOLUTE PIXELS (with the image dimensions stated
// in the prompt) — a 2026-06-19 experiment porting them to percentages REGRESSED
// accuracy on BOTH models (Opus included: it grounds best in the pixel frame it's
// given, and sometimes emitted pixel-magnitude values into the % fields), so it
// was reverted. Pixels are the proven path here.
//
// DEFAULT is Sonnet 4.6 (cost). To keep Sonnet accurate on CODE line-highlighting
// (its known weak spot — drifting boxes), the prompt teaches a LINE-GRID method:
// measure y0 (first line top) + lh (line height) once, then COMPUTE each line's
// band arithmetically instead of eyeballing it, and emit a forgiving full-width
// "highlight" band (rendered in overlay.js) rather than a tight floating box. This
// is what makes "box the exact line being explained / the line an example refers
// to" land reliably on Sonnet. Opus 4youtube.com
// ilable in Settings.
//
// Key is read from process.env (loaded by main.js, overridable in Settings).

// Vision models the user can pick in Settings → Screen Teacher model.
// We cap the screenshot to BOTH a long-edge limit (`maxEdge`) AND a MEGAPIXEL
// limit (`maxPixels`) before sending. The megapixel cap is the one the API
// actually enforces: per Anthropic's computer-use guidance the Sonnet 4.6 family
// silently downscales anything over ~1.15 MP, after which the model's coordinates
// no longer match the dimensions we report (imageWidth/imageHeight) — the #1 cause
// of coordinate drift. So we stay just under the limit (Sonnet ~1.1 MP ≈ 1.28k×0.86k;
// Opus has a larger 3.75 MP budget). Long-edge alone was NOT enough: 1568×882 on a
// 16:9 screen is 1.38 MP — over the Sonnet cap — which is exactly why pixel-coord
// annotations drifted. Keeping under the cap makes the sent image 1:1 with the
// frame we tell the model about, and with the overlay canvas.
const SCREEN_TEACHER_MODELS = {
  "claude-opus-4-7": { label: "Claude Opus 4.7 — most accurate", maxEdge: 2560, maxPixels: 3_600_000 },
  "claude-opus-4-8": { label: "Claude Opus 4.8 — most accurate", maxEdge: 2560, maxPixels: 3_600_000 },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6 — faster & cheaper", maxEdge: 1568, maxPixels: 1_100_000 },
};
const DEFAULT_SCREEN_TEACHER_MODEL = "claude-sonnet-4-6";

// Fall back to the default for an unknown id (e.g. a stale stored setting).
function resolveModel(modelId) {
  return SCREEN_TEACHER_MODELS[modelId] ? modelId : DEFAULT_SCREEN_TEACHER_MODEL;
}
function maxEdgeFor(modelId) {
  return SCREEN_TEACHER_MODELS[resolveModel(modelId)].maxEdge;
}
function maxPixelsFor(modelId) {
  return SCREEN_TEACHER_MODELS[resolveModel(modelId)].maxPixels;
}

const SYSTEM_PROMPT = `you are Screen Teacher, an assistant that looks at a screenshot of the user's screen and teaches them like a narrated, animated explainer — and, for step-by-step tasks, GUIDES them one action at a time, following along as they act.

you reply with ONLY this JSON object and NOTHING else:

{"done": true|false, "accumulate": true|false, "steps":[
  {"say":"one short spoken sentence","draw":[ <shape>, ... ]},
  {"say":"the next sentence","draw":[ <shape> ]}
]}

"steps" is an ordered list of narration moments. "say" is the sentence the narrator speaks at that moment — keep it natural; DO NOT change how you phrase the spoken explanation. "draw" is the annotation(s) that appear WHILE that sentence is spoken, and they play in order.

BE VISUALLY ACTIVE — this is the most important rule for "draw". Annotate GENEROUSLY: for EACH step, point at EVERY on-screen thing its sentence references. If the sentence names a button, a field, and a value, draw all THREE shapes in that step — not one. Aim for a rich, busy explainer where almost everything you say is also shown on screen, so prefer MORE relevant shapes per step over fewer. Every step that has anything visible to point at MUST carry at least one shape — never describe a visible element without annotating it. The one limit: only draw what THIS sentence is about (don't pre-draw a later step's targets); within that, be as visually thorough as the screen allows.

"accumulate" controls how steps are displayed:
- DEFAULT false — each step REPLACES the previous one: a shape appears, then disappears as the next step's shape appears. use this for navigation, UI pointing, "how do I…", coding, and most explanations — only the thing currently being discussed should be on screen.
- true — earlier steps STAY on screen and the picture builds up cumulatively. use this ONLY when the user needs to see prior steps to follow along — math problems and derivations, multi-line equations (e.g. "f(x)=a+b" then "f(x)=3+2", each line its own step placed just BELOW the previous), or a diagram assembled part by part. when true, position each new shape so it does NOT overlap the earlier ones.

"done" controls whether you are waiting to see the user act:
- set "done": false when the user must DO something (click / open / type / scroll) before they can progress, and you want to see the RESULT on the next screen before guiding further. you will then automatically be shown the new screen and asked to continue.
- set "done": true when the task is fully complete, OR when the request was just an explanation with no further action needed.

CODE & TECHNICAL step-by-step — when the screen shows code (an editor, a terminal, docs, a snippet on a web page) and the user wants it explained or walked through:
- break the explanation into steps that follow the code, and for EACH step highlight the EXACT line(s) of code that step is about so the spoken sentence maps directly onto the implementation, line by line, like a video tutorial. one step per line or small logical group of lines.
- use the "highlight" band (NOT a floating box) for code lines — it is your primary tool here and is far more forgiving than a tight box.
- IF a "TEXT/CODE ON SCREEN" list of lines is provided below, point at code by copying its line text VERBATIM into "code" (and "codeTo" for a range) instead of pixel coordinates — that places the highlight exactly on the real line. use the grid method below only for code the list does NOT cover.

  HOW TO LAND ON THE RIGHT LINE (this is the hard part — do it this way every time):
  code editors lay every line on a FIXED vertical grid, so MEASURE the grid ONCE and then COMPUTE each line, never eyeball lines independently:
    1. find y0 = the y-pixel of the TOP of the first visible code line.
    2. find lh = the line height in pixels = the vertical distance from one line's top to the next line's top (read it off two adjacent lines; it is constant).
    3. counting the first visible code line as line 1, line N spans y = y0 + (N-1)*lh  (top)  down to  y0 + N*lh.
  to highlight line N: "highlight" with y = y0 + (N-1)*lh and h = lh. to highlight lines N..M: y = y0 + (N-1)*lh and h = (M-N+1)*lh.
  for x/w: set x to the left edge of the code text and w to span the code column (you may extend to the right edge — a full-width band over the correct line still reads clearly even if x/w are loose). getting y and h right (via the grid) is what matters; that is where accuracy comes from.
- keep "accumulate": false here — each step highlights its own line(s) and the previous band clears as the next appears — UNLESS the user must compare separate lines/blocks at once (then use true).
- the same applies to other technical step-by-step breakdowns (config files, formulas, diagrams already on screen): map each spoken step to the precise element it describes.

GIVING AN EXAMPLE that explains on-screen code (sample values, a worked trace, a simplified rewrite):
- you MUST tie every example fragment to the exact on-screen line it illustrates. in the SAME step: "highlight" the line being explained AND place your example text with a "label" beside it (and optionally an "arrow" from the label to that line).
- NEVER just stack example text off to the side with nothing connecting it to the code — an example that doesn't point at the line it explains is wrong. one example fragment ↔ one highlighted line, step by step.

INTERACTIVE GUIDANCE — when the user asks "how do I…" or anything that takes several actions:
- guide exactly ONE action at a time, using ONLY what is actually visible on the CURRENT screen. do NOT point at or describe things that are not on screen yet (e.g. an item inside a menu/dropdown that hasn't been opened) — you will see them after the user opens it.
- the "say" tells them precisely what to do next ("Click the green Code button"), and "draw" points at that exact control. for action steps keep "say" to ONE short imperative sentence (~12 words) and emit just ONE step — be fast and concise, not chatty.
- set "done": false on each action step so you can react to what happens; set "done": true only once the goal is achieved on screen.
- on later turns you'll be told the user has acted and shown the updated screen — re-read it and guide the next single step (or finish).

supported shapes (coordinates are PIXELS of the screenshot you were given, origin (0,0) at the TOP-LEFT):
- {"shape":"arrow","from":[x,y],"to":[x,y],"label":"short text"}   point at something; label optional
- {"shape":"highlight","x":x,"y":y,"w":width,"h":height,"label":"short text"}   a translucent band over a line (or line range) of code/text — your PRIMARY tool for highlighting code lines (see the grid method above); label optional
- {"shape":"box","x":x,"y":y,"w":width,"h":height,"label":"short text"}   highlight a region; label optional
- {"shape":"circle","x":cx,"y":cy,"r":radius,"label":"short text"}   circle a thing; label optional
- {"shape":"line","from":[x,y],"to":[x,y]}   a plain line
- {"shape":"label","x":x,"y":y,"text":"short text"}   just text at a point

CHOOSE THE SHAPE THAT FITS WHAT YOU'RE SAYING — don't default to boxes; match the gesture a real tutor would make with a pen:
- POINTING at a specific control, element, value, or spot -> "arrow" from nearby open space TO the target, tip landing exactly on it. this is the default for "click X", "see this button", "notice that icon", "this number".
- ISOLATING or grouping a region, an icon, a shape, or a part of a diagram -> "circle" around it. use "box" ONLY for a genuinely rectangular area (a panel, toolbar, card, dialog, or text field) — not as a catch-all.
- a DIMENSION, DISTANCE, FLOW, or PATH ("the height of the triangle", "it flows from here to there", "this connects to that", "drag from A to B") -> "line" drawn ALONG that exact path. ORDER from/to by the natural direction, because it animates drawing from "from" to "to": a HEIGHT goes from the TOP point ("from") DOWN to the bottom ("to"); a flow/arrow-of-time goes from source ("from") to destination ("to").
- HIGHLIGHTING a line or range of code/text -> the "highlight" band.
- favor arrows, circles, and lines for an expressive, hand-drawn feel; mix shapes across steps rather than repeating the same one.
- any stroked shape (arrow, line, circle, box) may add "style":"dashed" to render as a dashed CONSTRUCTION line instead of a solid one.

CONSTRUCTIVE ANNOTATIONS — teach like a teacher at a whiteboard, not just a highlighter. you may COMPUTE and place coordinates in EMPTY space (not only on existing elements) to SYNTHESIZE new lines/shapes that make a concept or a calculation visible:
- EXTEND or COMPLETE a figure: a circle shows a 1cm radius and you say "the diameter is 1 x 2 = 2" -> compute the trajectory through the centre and draw the MISSING half so the full diameter is shown; do not just re-highlight the existing radius.
- SPAN a dimension: you say "the width is the two top circles' diameters combined" -> compute the outer-left edge of the left circle and the outer-right edge of the right circle and draw ONE horizontal line spanning the whole width.
- mark every constructed/inferred shape with "style":"dashed", so it reads as YOUR added construction line, visually distinct from what is actually on the screen.
RESTRAINT: synthesize a constructive shape ONLY when it directly bridges a cognitive gap or makes a calculation visible — it must be strictly necessary to aid understanding. never add inferred geometry just to decorate, and never duplicate a line that is already on screen. when in doubt, point at what is there.

rules:
- the question may come from imperfect speech-to-text and may contain transcription errors — homophones, brand names, or wrong/dropped small words (e.g. "Cloud" likely means "Claude"; "this what page" likely means "this web page"). interpret it CHARITABLY using what's actually visible on screen; answer the question the user clearly meant.
- the "say" sentence and its "draw" shapes MUST match: annotate EVERYTHING the sentence names — each distinct element, value, or region it mentions gets its own shape, placed exactly on the real thing. a sentence that references three on-screen items should produce three shapes, not one.
- point at things that are ACTUALLY visible in the screenshot, at their real pixel locations — the ONE exception is the deliberate constructive lines described above, which you may place in inferred/empty space.
- BE PRECISE with coordinates. read them carefully off the image: an arrow's "to" point must land exactly ON the target element; a box must tightly enclose it (not float beside or below it); a circle must be centered on it. when unsure, prefer an arrow pointing at the element over a box around an approximate region.
- keep each "say" to one natural spoken sentence; keep labels to a few words. for a pure explanation you may use several steps; for a task, usually ONE action step per turn.
- "draw":[] (no annotation) is ONLY for a step whose sentence points at nothing on screen — a purely abstract remark. if anything visible relates to what you're saying, annotate it; an empty "draw" should be rare.
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
  // "accumulate" = stack steps (math/derivations); default false = replace each step.
  const accumulate = data && !Array.isArray(data) && data.accumulate === true;

  if (rawSteps) {
    const steps = rawSteps
      .map((s) => ({
        say: String(s?.say ?? "").trim(),
        draw: Array.isArray(s?.draw) ? s.draw.filter((d) => d && typeof d === "object") : [],
      }))
      .filter((s) => s.say || s.draw.length);
    if (steps.length) {
      const explanation = steps.map((s) => s.say).filter(Boolean).join(" ");
      return { steps, explanation, done, accumulate };
    }
  }

  // Fallback: legacy [DRAW]+prose → one step with everything (no sync).
  const legacy = parseDrawInstructions(text);
  const say = legacy.explanation || "";
  return {
    steps: [{ say, draw: legacy.instructions }],
    explanation: say,
    done: true,
    accumulate: false,
  };
}

// ---------------------------------------------------------------------------
// OCR line-snapping (Sonnet path). Sonnet 4.6 can READ which line of code/text it
// wants to point at but can't estimate its pixel position (its boxes drift). So we
// OCR the SAME image we send it (main.js → win-automation.ocrImage), show it the
// lines, let it quote a line's VERBATIM text in "code", fuzzy-match that back to the
// OCR rect, and snap the annotation onto the real line. The model never has to
// guess coordinates — nor count line indexes (an earlier index-based version was
// consistently ~2 visible lines off because the model miscounted against this
// blank-stripped list). Opus 4.7/4.8 don't use this — they place pixels accurately.
// ---------------------------------------------------------------------------
const OCR_MAX_LINES = 160; // cap the list we show the model (token budget)

// Build the "TEXT/CODE ON SCREEN" block appended to the user turn. We DON'T number
// the lines: an earlier index-based version made the model count lines against this
// blank-stripped list, which it did consistently wrong (off by ~2 visible lines
// when a blank line sat between code lines). Instead the model copies a line's
// VERBATIM text into "code" and we fuzzy-match it back to the OCR rect — immune to
// miscounting. Showing OCR's exact spelling here lets the model copy text that
// matches 1:1.
function buildOcrPromptBlock(ocrLines) {
  const list = ocrLines
    .slice(0, OCR_MAX_LINES)
    .map((l) => String(l.text).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return `\n\nTEXT ON SCREEN — an OCR pass read these exact pieces of text off the screenshot, each at a known location:
${list}

To point at ANYTHING on screen, anchor it to its nearest visible text — DO NOT guess pixel x/y (you are bad at that). Set "code" to one of the strings FROM THE LIST ABOVE — the one at or next to your target — copied character-for-character EXACTLY as written there, even if OCR misspelled it (e.g. if the list shows ".1ßErn" for "18 cm", use ".1ßErn"). That guarantees we can locate it. We then place the mark on that text, right beside the feature it labels:
- a code line or sentence → its text:        {"shape":"highlight","code":"for i, n in enumerate(nums):","label":"optional caption"}
- a block of lines →                          {"shape":"highlight","code":"<first line text>","codeTo":"<last line text>"}
- a value / measurement / angle / variable on a DIAGRAM (its label IS the anchor) →
      circle it:  {"shape":"circle","code":"34°","label":"angle"}        (anchors on the "34°" next to that angle)
      arrow it:   {"shape":"arrow","code":"10 cm","label":"opposite side"}
- a note beside a line →                       {"shape":"label","code":"diff = target - n","text":"diff = 9 - 2 = 7"}

RULES:
- "code"/"codeTo" must be LITERAL text shown on screen (that is how we locate it) — never a description. Put descriptions in "label" / notes in "text".
- For a DIAGRAM (triangle, graph, shape): point at its LABELED parts — a side length, an angle value, a vertex letter — using their labels as "code". Do NOT draw a box around the whole figure, and do NOT invent a coordinate for an unlabeled point.
- Only as a LAST resort, for a target with genuinely no nearby text (a bare icon), use raw pixel x/y.
- If you cannot anchor a mark to nearby text and you are not certain of the exact pixel spot, DO NOT draw it — just describe that part in "say" with an empty "draw":[]. A missing annotation is fine; a misplaced one is not.`;
}

// Match key for comparing the model's quoted line against OCR text. We keep only
// lowercase letters+digits — dropping ALL whitespace, punctuation and symbols —
// because OCR mangles exactly those on diagrams/code (the degree sign in "34°" is
// read as "340"; "print (foo (41))" gains spaces; a trailing ":" comes and goes).
// Letters+digits survive far more reliably, so matching on them is robust.
function normalizeLineText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// Sørensen–Dice bigram similarity (0–1) — robust to small OCR/transcription diffs.
function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  const B = bigrams(b);
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) { inter++; counts.set(g, c - 1); }
  }
  return (2 * inter) / (A.length + B.length);
}

// Index of the OCR line that best matches `query` text, or -1 if nothing clears
// `minScore`. Exact (normalized) and substring matches win; otherwise the best
// bigram similarity. `minScore` is the confidence floor: the explicit "code" path
// uses the default (the model quoted the anchor on purpose); the label fallback
// passes a high floor so a semantic caption like "angle" can't hijack a sentence
// that merely contains the word.
function bestOcrMatch(query, ocrLines, minScore = 0.5) {
  const q = normalizeLineText(query);
  if (q.length < 2) return -1;
  let best = -1;
  let bestScore = minScore;
  for (let i = 0; i < ocrLines.length; i++) {
    const t = normalizeLineText(ocrLines[i] && ocrLines[i].text);
    if (t.length < 2) continue;
    let score;
    if (t === q) score = 1;
    else if (t.includes(q) || q.includes(t)) score = 0.6 + 0.4 * (Math.min(q.length, t.length) / Math.max(q.length, t.length));
    else score = diceSimilarity(q, t);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// Resolve a shape's line reference to a pixel box, by matching its quoted TEXT to
// the OCR line(s). Each shape resolves INDEPENDENTLY — there is deliberately no
// integer line index and no reference to a previous box, so one bad anchor can't
// shift the others (an earlier index-based version *did* cascade like that: the
// model miscounted lines against the blank-stripped list and every box drifted the
// same ~1–2 lines). "code" picks the line; "codeTo" extends to a range. Returns the
// union { x, y, w, h } or null if nothing matches confidently.
function rectForLineRef(shape, ocrLines) {
  let idxs = [];

  // Primary: verbatim text the model quoted for this shape.
  if (typeof shape.code === "string" && shape.code.trim()) {
    const a = bestOcrMatch(shape.code, ocrLines);
    if (a >= 0) {
      if (typeof shape.codeTo === "string" && shape.codeTo.trim()) {
        const b = bestOcrMatch(shape.codeTo, ocrLines);
        if (b >= 0) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          for (let i = lo; i <= hi; i++) idxs.push(i);
        } else idxs = [a];
      } else idxs = [a];
    }
  }

  // Fallback: if a pointing shape gave no "code" but its label happens to BE the
  // line's text (the model's older habit), match on that — but only at a high floor,
  // so a semantic caption ("the loop", "angle") that merely shares a word with a
  // line can't hijack it. It must essentially equal the line's text.
  if (!idxs.length && shape.shape !== "label" && typeof shape.label === "string" && shape.label.trim()) {
    const a = bestOcrMatch(shape.label, ocrLines, 0.82);
    if (a >= 0) idxs = [a];
  }

  const rects = idxs.map((i) => ocrLines[i]).filter((r) => r && Number.isFinite(r.x));
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

// A shape is drawable only if it carries the coordinates its type needs. Drops
// coordinate-less leftovers (e.g. a stray `line` index now that the index path is
// gone) so the canvas never gets garbage. Unknown shapes are left to the overlay's
// own try/catch.
function isDrawableShape(s) {
  const num = (v) => Number.isFinite(v);
  switch (s && s.shape) {
    case "highlight":
    case "box": return num(s.x) && num(s.y) && num(s.w) && num(s.h);
    case "circle": return num(s.x) && num(s.y) && num(s.r);
    case "arrow":
    case "line": return Array.isArray(s.from) && Array.isArray(s.to) && num(s.from[0]) && num(s.from[1]) && num(s.to[0]) && num(s.to[1]);
    case "label": return num(s.x) && num(s.y) && typeof s.text === "string";
    default: return true;
  }
}

// Replace line-referenced shapes with concrete pixel shapes anchored on the OCR
// rects. A shape that carries no resolvable line ref passes through unchanged (so
// the model's raw-pixel fallback for textless targets still works); anything that
// ends up without usable coordinates is dropped.
function resolveLineRefs(steps, ocrLines, imageWidth, imageHeight) {
  if (!Array.isArray(ocrLines) || !ocrLines.length) return steps;
  const padX = Math.max(6, Math.round((imageWidth || 1280) / 180));
  const hasRef = (s) =>
    (typeof s.code === "string" && s.code.trim()) || // verbatim text ref (primary)
    // a pointing shape whose label may be the line's code text (older model habit)
    (s.shape !== "label" && typeof s.label === "string" && !!s.label.trim());

  return steps.map((step) => ({
    ...step,
    draw: (step.draw || []).map((shape) => {
      if (!hasRef(shape)) return shape;
      const rect = rectForLineRef(shape, ocrLines);
      if (!rect) {
        // Unresolvable ref (e.g. a hallucinated index): keep only if the shape
        // still carries usable pixel coords, otherwise drop it so the canvas never
        // tries to draw a coordinate-less shape.
        return Number.isFinite(shape.x) || Array.isArray(shape.from) ? shape : null;
      }
      const label = typeof shape.label === "string" && shape.label.trim() ? shape.label : undefined;
      const cy = Math.round(rect.y + rect.h / 2);

      if (shape.shape === "arrow" || shape.shape === "line") {
        const reach = Math.round((imageWidth || 1280) / 12);
        // Prefer a horizontal arrow into the line's left edge from the margin; but
        // if the code hugs the left edge (no room), point down at it from above so
        // the arrow is still long enough to read.
        if (rect.x - padX > reach) {
          const toX = rect.x - padX;
          return { shape: "arrow", from: [toX - reach, cy], to: [toX, cy], ...(label ? { label } : {}) };
        }
        const cx = Math.round(rect.x + Math.min(rect.w / 2, rect.h * 1.5));
        const toY = Math.max(2, rect.y - 2);
        const fromY = Math.max(2, toY - Math.max(rect.h * 2, Math.round((imageHeight || 800) / 16)));
        return { shape: "arrow", from: [cx, fromY], to: [cx, toY], ...(label ? { label } : {}) };
      }
      if (shape.shape === "circle") {
        // Circle the whole label (use its larger half-dimension) so a short anchor
        // like "34°" gets a clearly visible ring, not a dot.
        return { shape: "circle", x: Math.round(rect.x + rect.w / 2), y: cy, r: Math.round(Math.max(rect.w, rect.h) / 2 + padX), ...(label ? { label } : {}) };
      }
      if (shape.shape === "label") {
        // Example/note text glued just to the RIGHT of the line it explains.
        return { shape: "label", x: rect.x + rect.w + padX, y: rect.y, text: String(shape.text || "") };
      }
      // default (highlight / box / anything else) → forgiving line band over the line(s)
      const bandPad = 3;
      return {
        shape: "highlight",
        x: Math.max(0, rect.x - padX),
        y: Math.max(0, rect.y - bandPad),
        w: rect.w + padX * 2,
        h: rect.h + bandPad * 2,
        ...(label ? { label } : {}),
      };
    }).filter((s) => s && isDrawableShape(s)),
  }));
}

// Incremental parser for the STREAMED Teacher JSON. Fed the GROWING response text
// each tick, it returns any newly-completed step objects inside "steps":[...] (plus
// the top-level done/accumulate once the array starts), so playback can begin on
// step 0 while the rest still generates. String/escape/brace-depth aware (a step's
// "draw" holds nested shape objects). The end-of-stream parseSteps() reconciliation
// in askAboutScreen is the safety net if anything here misses a step.
function createStepStreamParser() {
  let cursor = -1; // scan position inside the steps array; -1 until "[" is found
  let metaEmitted = false;

  // Index just past the matching "}" of the object starting at buf[from] ("{"),
  // or -1 if it hasn't fully arrived yet. Honors strings and \-escapes.
  function objectEnd(buf, from) {
    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i + 1; }
    }
    return -1;
  }

  return function feed(buf) {
    const out = { steps: [], meta: null };
    if (!metaEmitted) {
      const start = buf.match(/"steps"\s*:\s*\[/);
      if (start) {
        const head = buf.slice(0, start.index); // done/accumulate precede the array
        const dm = head.match(/"done"\s*:\s*(true|false)/);
        const am = head.match(/"accumulate"\s*:\s*(true|false)/);
        out.meta = { done: dm ? dm[1] === "true" : true, accumulate: am ? am[1] === "true" : false };
        metaEmitted = true;
        cursor = start.index + start[0].length;
      }
    }
    if (cursor === -1) return out; // the steps array hasn't begun
    while (cursor < buf.length) {
      while (cursor < buf.length && " \n\r\t,".includes(buf[cursor])) cursor++; // skip separators
      if (cursor >= buf.length || buf[cursor] === "]") break; // end of array (or nothing yet)
      if (buf[cursor] !== "{") break; // not an object start (incomplete / stray)
      const end = objectEnd(buf, cursor);
      if (end === -1) break; // this step object is still streaming
      const slice = buf.slice(cursor, end);
      cursor = end;
      try { out.steps.push(JSON.parse(slice)); } catch { /* reconciliation recovers it */ }
    }
    return out;
  };
}

// Ask the vision model about the current screen.
//   question   — the user's goal (used as the prompt on the first turn).
//   turnText   — overrides the prompt text on later guide turns ("the user acted…").
//   history    — prior turns (Anthropic message objects, text-only) for guide mode.
// Returns { ok, steps, explanation, done, raw }. `done:false` means the guide
// loop should watch for the user to act, then call again with the new screen.
async function askAboutScreen({ imageBase64, mediaType = "image/png", question, imageWidth, imageHeight, history = [], turnText = null, model, ocrLines = [], onStep = null, onMeta = null, signal = null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY is missing — set it in Settings or .env" };

  // Anchor the model's coordinate frame by stating the exact image size, so its
  // pixel estimates are in the same space the overlay canvas renders.
  const base = turnText ?? ((question || "").trim() || "Explain what's on my screen and point out the key parts.");
  const dims =
    imageWidth && imageHeight
      ? `\n\nThe screenshot is exactly ${imageWidth}×${imageHeight} pixels (top-left is 0,0). Every coordinate you output must be an integer in that range: x in 0–${imageWidth}, y in 0–${imageHeight}.`
      : "";
  // Sonnet path: hand it OCR'd lines + indexes so it points by INDEX (we snap to
  // the real rect) instead of guessing pixels. Empty for Opus → unchanged behavior.
  const useOcr = Array.isArray(ocrLines) && ocrLines.length > 0;
  const ocrBlock = useOcr ? buildOcrPromptBlock(ocrLines) : "";
  const userText = base + dims + ocrBlock;

  // Text BEFORE image — per Anthropic's computer-use guidance this lets the model
  // read the target/instructions first and improves coordinate accuracy.
  const userTurn = {
    role: "user",
    content: [
      { type: "text", text: userText },
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
    ],
  };

  // Streaming only when the caller wants step-by-step delivery (onStep). Otherwise
  // we buffer the whole reply exactly as before — a safe fallback for any caller.
  const streaming = typeof onStep === "function";
  const snap = (stepsArr) => (useOcr ? resolveLineRefs(stepsArr, ocrLines, imageWidth, imageHeight) : stepsArr);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: resolveModel(model),
        max_tokens: 2048,
        // Cache the (large, static) system prompt so multi-turn guide sessions
        // don't reprocess it each step — lowers time-to-first-token on turns 2+.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [...history, userTurn],
        ...(streaming ? { stream: true } : {}),
      }),
    });

    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${await res.text()}` };

    // ---- Buffered path (no onStep): unchanged behavior --------------------
    if (!streaming) {
      const data = await res.json();
      // Take the TEXT block(s) — content[0] can be a "thinking" block (adaptive thinking).
      const text = (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
      const parsed = parseSteps(text);
      // Snap any line-referenced shapes onto the real OCR rects (Sonnet path); a
      // no-op when ocrLines is empty (Opus) or the model used raw pixel coords.
      return { ok: true, steps: snap(parsed.steps), explanation: parsed.explanation, done: parsed.done, accumulate: parsed.accumulate, raw: text };
    }

    // ---- Streaming path: emit each step the instant it parses -------------
    const feedSteps = createStepStreamParser(); // returns the feed() fn directly
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let full = ""; // accumulated model text (the JSON we're parsing)
    let sse = ""; // partial SSE line buffer
    let emitted = 0;

    // Normalize each step exactly like parseSteps (trim say, keep only object shapes,
    // drop fully-empty steps) so the streamed path is identical to the buffered one.
    const norm = (s) => ({
      say: String((s && s.say) || "").trim(),
      draw: Array.isArray(s && s.draw) ? s.draw.filter((d) => d && typeof d === "object") : [],
    });
    const consume = (delta) => {
      if (!delta) return;
      full += delta;
      const { steps, meta } = feedSteps(full);
      if (meta && onMeta) onMeta(meta);
      for (const raw of steps) {
        const step = norm(raw);
        if (!step.say && !step.draw.length) continue; // skip empties, like parseSteps
        const resolved = snap([step])[0]; // per-step line-snap (stateless across steps)
        if (resolved) onStep(resolved, emitted++);
      }
    };

    for (;;) {
      const { done: rDone, value } = await reader.read();
      if (rDone) break;
      sse += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = sse.indexOf("\n")) !== -1) {
        const line = sse.slice(0, nl).trim();
        sse = sse.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          consume(evt.delta.text || "");
        } else if (evt.type === "error") {
          throw new Error((evt.error && evt.error.message) || "Anthropic stream error");
        }
      }
    }

    // Safety net: reconcile against a full parse so we never emit fewer steps than
    // the buffered path would — recovers any step the incremental parser missed.
    const parsed = parseSteps(full);
    const finalSteps = snap(parsed.steps);
    for (let i = emitted; i < finalSteps.length; i++) onStep(finalSteps[i], emitted++);

    return { ok: true, raw: full, done: parsed.done, accumulate: parsed.accumulate, stepCount: emitted };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "aborted", aborted: true };
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
    const cleaned = (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
    return cleaned || text;
  } catch {
    return text; // network/parse failure → fall back to raw
  }
}

module.exports = {
  askAboutScreen,
  createStepStreamParser,
  cleanVoiceQuery,
  parseSteps,
  parseDrawInstructions,
  resolveLineRefs,
  SCREEN_TEACHER_MODELS,
  DEFAULT_SCREEN_TEACHER_MODEL,
  maxEdgeFor,
  maxPixelsFor,
};
