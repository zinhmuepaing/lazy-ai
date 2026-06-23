// Streaming step parser — verify incremental extraction matches a full parse, at any
// chunk boundary, with braces/escapes inside strings, nested draw shapes, and an empty
// draw. This is the safety net behind DeskTutor's "play step 0 while the rest streams".
const screenTeacher = require("../src/screen-teacher");
const { createStepStreamParser, parseSteps } = screenTeacher;

let passed = 0;
function ok(name, cond) {
  if (!cond) { console.error("FAIL ", name); process.exit(1); }
  console.log("PASS ", name);
  passed++;
}

// A realistic Teacher reply: done/accumulate BEFORE steps; a "say" with braces and an
// escaped quote; nested draw shapes; a dashed constructive line; and a final empty draw.
const reply = {
  done: false,
  accumulate: false,
  steps: [
    { say: 'Look at the {main} panel and the "Save" button.', draw: [{ shape: "arrow", from: [10, 20], to: [30, 40], label: "here" }] },
    { say: "Now the height.", draw: [{ shape: "line", from: [50, 10], to: [50, 90], style: "dashed" }, { shape: "circle", x: 5, y: 5, r: 9 }] },
    { say: "That's it.", draw: [] },
  ],
};
const full = JSON.stringify(reply);

// Feed the GROWING buffer in fixed-size chunks (mirrors how feed() is called with the
// accumulating SSE text); collect every emitted step + the meta.
function runChunked(text, size) {
  const feed = createStepStreamParser();
  const steps = [];
  let meta = null;
  let buf = "";
  for (let i = 0; i < text.length; i += size) {
    buf += text.slice(i, i + size);
    const out = feed(buf);
    if (out.meta && !meta) meta = out.meta;
    for (const s of out.steps) steps.push(s);
  }
  return { steps, meta };
}

const want = JSON.stringify(reply.steps);
for (const size of [1, 2, 3, 5, 13, 1000]) {
  const { steps, meta } = runChunked(full, size);
  ok(`chunk=${size}: meta done=false, accumulate=false`, meta && meta.done === false && meta.accumulate === false);
  ok(`chunk=${size}: emitted exactly 3 steps`, steps.length === 3);
  ok(`chunk=${size}: steps deep-equal the source (braces/escapes/nesting intact)`, JSON.stringify(steps) === want);
}

// Reconciliation: the incremental result equals a full parseSteps of the same text.
const fp = parseSteps(full);
ok("parseSteps yields the same 3 steps (reconciliation parity)", JSON.stringify(fp.steps) === want);
ok("parseSteps done=false", fp.done === false);

// A partial buffer cut mid-second-step must emit ONLY the first complete step (never a
// truncated/duplicate object) — this is what lets playback start safely on step 0.
(() => {
  const feed = createStepStreamParser();
  const out = feed(full.slice(0, full.indexOf("Now the height")));
  ok("partial buffer: only the first complete step is emitted", out.steps.length === 1 && out.steps[0].say.startsWith("Look at the {main}"));
})();

// Continuing to feed the rest later yields the remaining steps with no repeats. The cut
// is mid-second-step (step 1 already closed), so the first feed emits only step 1.
(() => {
  const feed = createStepStreamParser();
  feed(full.slice(0, full.indexOf("Now the height"))); // step 1 complete; step 2 still partial
  const rest = feed(full); // now the whole thing
  ok("resuming the feed emits the remaining 2 steps, no repeat of step 1", rest.steps.length === 2 && rest.steps[0].say === "Now the height.");
})();

// ---- End-to-end streaming path (stubbed fetch, no network) ------------------
// Exercises askAboutScreen's real SSE → feed → onStep pipeline, so a call-site bug
// (e.g. "parser.feed is not a function", or a broken SSE/line split) fails HERE
// rather than only at runtime when the user sends a request.
function makeSSE(modelText, chunk) {
  let s = "";
  for (let i = 0; i < modelText.length; i += chunk) {
    const piece = modelText.slice(i, i + chunk);
    s += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } })}\n\n`;
  }
  return s + `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}
function stubStreamingFetch(sseText, byteChunk) {
  const bytes = new TextEncoder().encode(sseText);
  let pos = 0;
  global.fetch = async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (pos >= bytes.length) return { done: true, value: undefined };
          const end = Math.min(pos + byteChunk, bytes.length);
          const value = bytes.slice(pos, end);
          pos = end;
          return { done: false, value };
        },
      }),
    },
  });
}

(async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    stubStreamingFetch(makeSSE(full, 9), 6); // model text in 9-char deltas, transport in 6-byte reads
    const got = [];
    let meta = null;
    const result = await screenTeacher.askAboutScreen({
      imageBase64: "AAAA",
      mediaType: "image/png",
      question: "explain my screen",
      imageWidth: 100,
      imageHeight: 100,
      model: screenTeacher.DEFAULT_SCREEN_TEACHER_MODEL,
      onMeta: (m) => { meta = m; },
      onStep: (step) => { got.push(step); },
    });
    ok("askAboutScreen(streaming): ok=true", result && result.ok === true);
    ok("askAboutScreen(streaming): onMeta fired with done=false", meta && meta.done === false);
    ok("askAboutScreen(streaming): onStep emitted all 3 steps", got.length === 3);
    ok("askAboutScreen(streaming): emitted steps match source", JSON.stringify(got) === want);
    ok("askAboutScreen(streaming): returns full raw + done + stepCount", result.raw === full && result.done === false && result.stepCount === 3);
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
  console.log(`\nAll ${passed} streaming assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
