// Lizzie — premium text-to-speech (Phase 1B).
//
// Wraps `msedge-tts`, a pure-JS WebSocket client for Microsoft Edge's free
// "read aloud" neural voices — NO Azure subscription key required. We use the
// "Ava (multilingual)" voice and return an MP3 Buffer the renderer plays.
//
// This is a free CLOUD call (it needs internet), so callers should treat a
// thrown error as "fall back to the local Windows speechSynthesis voice"
// (overlay.js does exactly that). Calls are serialized over a single reused
// socket; any failure drops the connection so the next call reconnects fresh.

// NB: the class is exported as `MsEdgeTTS` (not `MSEdgeTTS`).
const { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } = require("msedge-tts");

const VOICE = "en-US-AvaMultilingualNeural";
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const MIME = "audio/mpeg";

const SYNTH_TIMEOUT_MS = 7000; // cap a hung socket so the IPC rejects (caller falls back)

let ttsPromise = null; // cached, metadata-configured MSEdgeTTS instance
let queue = Promise.resolve(); // serializes synth calls over the one socket

// Verbose pipeline tracing — OFF by default. Flip to true to debug the TTS flow in
// the terminal. Genuine failures use console.error and are always shown.
const TTS_DEBUG = false;
const dlog = (...a) => { if (TTS_DEBUG) console.info(...a); };

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Pre-open the Edge-TTS websocket so the FIRST narration skips the handshake
// (cold first-chunk ~3.4s → warm sub-second). Fire-and-forget; errors are ignored
// here — we reconnect lazily on the real call, or fall back to the local voice.
function warmUp() {
  getTTS().then(
    () => dlog("[tts] warmed up (connection ready)"),
    (err) => dlog(`[tts] warm-up skipped: ${String((err && err.message) || err)}`)
  );
}

function getTTS() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      dlog(`[tts] opening Edge-TTS connection (voice=${VOICE})…`);
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICE, FORMAT);
      dlog("[tts] Edge-TTS connection established");
      return tts;
    })();
    ttsPromise.catch(() => {
      ttsPromise = null;
    });
  }
  return ttsPromise;
}

// True only if the cached connection's websocket is OPEN (readyState 1). A warm
// connection can idle out, so we check this before reusing it.
function socketAlive(tts) {
  return !!(tts && tts._ws && tts._ws.readyState === 1);
}

// HARD KILL. When the user interrupts (or a new turn starts) while a prefetch is
// mid-stream, aborting the client request alone doesn't stop Edge — it keeps
// streaming the abandoned audio over the SHARED socket and starves the next
// request, which then times out to the robotic voice. Closing the socket forces
// Edge to stop; we drop the queue and re-warm a fresh connection. No-op when
// nothing is in flight, so a clean new turn keeps its (fast) warm socket.
function resetConnection() {
  if (pendingStreams === 0) return;
  dlog("[tts] hard kill: closing the Edge-TTS connection to drop stale audio");
  const prev = ttsPromise;
  ttsPromise = null;
  streamGate = Promise.resolve(); // fresh queue — don't wait on the killed stream
  pendingStreams = 0;
  if (prev) prev.then((tts) => { try { tts.close(); } catch {} }, () => {});
  warmUp(); // reopen now so the next request is fast + uncontended
}

// Build a COMPLETE prosody options object. We must set pitch/rate/volume or the
// library can splice `undefined` into the SSML and break synthesis — so prefer
// the library's ProsodyOptions (which carries sane defaults) and only override
// the rate. `rate` is a multiplier (1.05 = 5% faster), matching the lib default.
function buildOptions(rate) {
  const opts = ProsodyOptions ? new ProsodyOptions() : { pitch: "+0Hz", rate: 1.0, volume: 100 };
  if (typeof rate === "number" && Number.isFinite(rate)) opts.rate = rate;
  return opts;
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => finish());
    stream.on("close", () => finish());
    stream.on("error", (err) => finish(err));
  });
}

async function synthesizeOnce(text, rate) {
  const tts = await getTTS();
  dlog("[tts] connection ready; streaming audio…");
  const result = tts.toStream(text, buildOptions(rate));
  // Newer msedge-tts returns { audioStream, metadataStream }; older returns a
  // bare Readable. Handle both.
  const audioStream = result && result.audioStream ? result.audioStream : result;
  const audio = await collectStream(audioStream);
  if (!audio || !audio.length) throw new Error("Edge-TTS returned no audio");
  return { audio, mime: MIME };
}

// Synthesize `text` to an MP3 Buffer. Throws on any failure (no key, offline,
// endpoint hiccup) so the caller can fall back to a local voice.
async function synthesize(text, { rate } = {}) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("No text to speak");
  dlog(`[tts] request: "${clean.slice(0, 48)}${clean.length > 48 ? "…" : ""}" (${clean.length} chars) voice=${VOICE}`);

  const run = queue.then(() => withTimeout(synthesizeOnce(clean, rate), SYNTH_TIMEOUT_MS, "Edge-TTS"));
  queue = run.catch(() => {}); // keep the chain alive regardless of outcome
  try {
    const out = await run;
    dlog(`[tts] success: ${out.audio.length} bytes mp3`);
    return out;
  } catch (err) {
    console.error(`[tts] FAILED → caller falls back to speechSynthesis: ${String(err && err.message || err)}`);
    ttsPromise = null; // drop the (possibly dead) socket; reconnect next time
    throw err;
  }
}

let streamGate = Promise.resolve(); // serialize toStream over the one shared socket
let pendingStreams = 0; // diagnostic: stream requests currently in-flight or queued

// Streaming variant: returns the raw audio Readable as soon as Edge-TTS starts
// producing it — NO buffering. The caller (local-server GET /tts) pipes it to the
// HTTP response so the renderer's <audio> plays chunks as they arrive. This makes
// start latency = time-to-first-chunk, independent of total sentence length.
function synthesizeStream(text, { rate } = {}) {
  const clean = String(text || "").trim();
  if (!clean) return Promise.reject(new Error("No text to speak"));
  // Requests are SERIALIZED over the one Edge-TTS socket (streamGate) — toStream is
  // never called concurrently. A non-zero "queued behind" means a prefetch is
  // correctly WAITING for the active stream instead of racing it for bandwidth.
  pendingStreams += 1;
  const queued = pendingStreams - 1;
  dlog(`[tts] stream request${queued > 0 ? ` (queued behind ${queued})` : ""}: "${clean.slice(0, 48)}${clean.length > 48 ? "…" : ""}" (${clean.length} chars) voice=${VOICE}`);

  // Don't start a new synthesis on the shared socket until the previous stream
  // has finished; advance the gate when this one ends/closes/errors.
  const startPromise = streamGate.then(async () => {
    let tts = await getTTS();
    // A warm connection can idle out (Edge closes it); reconnect if the socket
    // isn't OPEN, or the first request would hang until the fallback timeout.
    if (!socketAlive(tts)) {
      dlog("[tts] cached connection is stale — reconnecting");
      ttsPromise = null;
      tts = await getTTS();
    }
    dlog("[tts] connection ready; streaming…");
    const result = tts.toStream(clean, buildOptions(rate));
    const stream = result && result.audioStream ? result.audioStream : result;
    // 'end'/'close'/'error' don't flip the stream into flowing mode, so attaching
    // them here won't drop data before the route pipes it.
    const finished = new Promise((resolve) => {
      stream.once("end", resolve);
      stream.once("close", resolve);
      stream.once("error", resolve);
    });
    return { stream, finished };
  });

  streamGate = startPromise
    .then(({ finished }) => finished, () => { ttsPromise = null; }) // failed start → drop socket
    .finally(() => { if (pendingStreams > 0) pendingStreams -= 1; });

  return startPromise.then(({ stream }) => ({ stream, mime: MIME }));
}

module.exports = { synthesize, synthesizeStream, warmUp, resetConnection, VOICE, MIME };
