// Screen Teacher overlay (renderer). Sizes the canvas to the screenshot,
// sends the user's question to the main process, and renders the AI's
// [DRAW:...] instructions onto the transparent canvas over the live screen.

const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");
const els = {
  bar: document.getElementById("bar"),
  question: document.getElementById("question"),
  askBtn: document.getElementById("askBtn"),
  micBtn: document.getElementById("micBtn"),
  closeBtn: document.getElementById("closeBtn"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
};

// Canvas internal resolution = screenshot pixels, so AI coordinates (which map
// 1:1 to screenshot pixels) can be drawn without any scaling. CSS stretches the
// canvas to fill the screen.
let imageWidth = window.innerWidth;
let imageHeight = window.innerHeight;

// "teach" = Screen Teacher (explain/draw); "control" = Screen Control (act).
let overlayMode = "teach";
const barTitle = document.querySelector(".bar-title");

function resizeCanvas() {
  canvas.width = imageWidth;
  canvas.height = imageHeight;
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// Floating, container-less status text (centered) + an audio-wave shown while
// speaking. `kind` colors it (loading / err / ok). The "speaking" class is kept
// across text updates so the wave doesn't flicker mid-utterance.
function setAnswer(text, kind = "") {
  els.statusText.textContent = text || "";
  const speaking = els.status.classList.contains("speaking");
  els.status.className = (text ? "show" : "") + (kind ? " " + kind : "") + (speaking ? " speaking" : "");
  syncFollowLoop(); // start/stop the cursor-follow loop with the pill's visibility
}

function setSpeaking(on) {
  els.status.classList.toggle("speaking", on);
  syncFollowLoop();
}

// ---- Drawing primitives (coordinates are screenshot pixels) ---------------
// Every shape is drawn through an `anim` object so the walkthrough can reveal it
// over time: { progress 0→1 (entrance), pulse 0→1 (breathing glow), alpha }.
const ACCENT = "#ec4d25"; // coral — visible over screenshots
const LABEL_BG = "rgba(236, 77, 37, 0.96)";

// Line width scales with the screenshot size so HiDPI captures don't hairline.
function baseStroke() {
  return Math.max(4, Math.round(imageWidth / 420));
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const STATIC = { progress: 1, pulse: 0, alpha: 1 }; // fully-revealed, no glow

function styleStroke(pulse) {
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = baseStroke() * (0.85 + 0.35 * pulse);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = ACCENT;
  ctx.shadowBlur = 18 * pulse; // the "highlight" — pulses while a step is spoken
}

function drawLabel(x, y, text, alpha = 1) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowBlur = 0;
  const fontSize = Math.max(18, Math.round(imageWidth / 90));
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  const padding = fontSize * 0.4;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padding * 2;
  const h = fontSize + padding * 2;
  // keep the label on-screen
  const lx = Math.min(Math.max(x, 0), canvas.width - w);
  const ly = Math.min(Math.max(y, h), canvas.height) - h;
  ctx.fillStyle = LABEL_BG;
  ctx.beginPath();
  ctx.roundRect(lx, ly, w, h, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, lx + padding, ly + fontSize + padding * 0.6);
  ctx.restore();
}

function drawArrow(from, to, label, a) {
  const { progress, pulse, alpha } = a;
  ctx.save();
  ctx.globalAlpha = alpha;
  styleStroke(pulse);
  const [x1, y1] = from;
  const [x2, y2] = to;
  // shaft grows from tail to tip as the step is narrated
  const tipX = x1 + (x2 - x1) * progress;
  const tipY = y1 + (y2 - y1) * progress;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // arrowhead fades in over the last stretch, riding the current tip
  if (progress > 0.55) {
    ctx.globalAlpha = alpha * Math.min(1, (progress - 0.55) / 0.45);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = baseStroke() * 4;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - head * Math.cos(angle - Math.PI / 6), tipY - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tipX - head * Math.cos(angle + Math.PI / 6), tipY - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  if (label && progress > 0.5) drawLabel(x1, y1 - 10, label, alpha * Math.min(1, (progress - 0.5) / 0.5));
}

// A translucent band over a line (or line range) of code/text — like a code
// editor's current-line highlight. This is the Teacher's primary tool for
// pointing at exact lines: a filled band keyed to the line grid reads clearly
// even when the model's x/w are loose, so it's far more forgiving than a tight
// box. It wipes in from the left and breathes (alpha) with the step's pulse,
// with a bright left accent bar like an editor's current-line marker.
function drawHighlight(x, y, w, h, label, a) {
  const { progress, pulse, alpha } = a;
  ctx.save();
  ctx.globalAlpha = alpha * Math.min(1, progress / 0.35); // fade in early
  const ww = w * easeOut(Math.min(1, progress / 0.8)); // band wipes in left→right
  ctx.shadowColor = ACCENT;
  ctx.shadowBlur = 16 * pulse;
  ctx.fillStyle = `rgba(236, 77, 37, ${0.15 + 0.1 * pulse})`;
  ctx.beginPath();
  ctx.roundRect(x, y, ww, h, 4);
  ctx.fill();
  // bright left accent bar — the editor "current line" marker
  ctx.shadowBlur = 0;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x, y, Math.max(3, baseStroke() * 0.7), h);
  ctx.restore();
  if (label && progress > 0.4) drawLabel(x, y - 6, label, alpha);
}

function drawBox(x, y, w, h, label, a) {
  const { progress, pulse, alpha } = a;
  ctx.save();
  ctx.globalAlpha = alpha * Math.min(1, progress / 0.4); // fade in early
  styleStroke(pulse);
  // a touch of grow-from-center on entrance, settling to the true rect
  const s = 0.94 + 0.06 * easeOut(progress);
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.strokeRect(cx - (w * s) / 2, cy - (h * s) / 2, w * s, h * s);
  ctx.restore();
  if (label && progress > 0.4) drawLabel(x, y - 6, label, alpha);
}

function drawCircle(cx, cy, r, label, a) {
  const { progress, pulse, alpha } = a;
  ctx.save();
  ctx.globalAlpha = alpha;
  styleStroke(pulse);
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); // sweep in
  ctx.stroke();
  ctx.restore();
  if (label && progress > 0.5) drawLabel(cx - r, cy - r - 6, label, alpha);
}

function drawLine(from, to, a) {
  const { progress, pulse, alpha } = a;
  ctx.save();
  ctx.globalAlpha = alpha;
  styleStroke(pulse);
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress);
  ctx.stroke();
  ctx.restore();
}

// Draw one [DRAW] shape at the given animation phase.
function drawInstruction(ins, a) {
  try {
    switch (ins.shape) {
      case "arrow": drawArrow(ins.from, ins.to, ins.label, a); break;
      case "highlight": drawHighlight(ins.x, ins.y, ins.w, ins.h, ins.label, a); break;
      case "box": drawBox(ins.x, ins.y, ins.w, ins.h, ins.label, a); break;
      case "circle": drawCircle(ins.x, ins.y, ins.r, ins.label, a); break;
      case "line": drawLine(ins.from, ins.to, a); break;
      case "label": drawLabel(ins.x, ins.y, ins.text, a.alpha * a.progress); break;
    }
  } catch {
    // ignore a single malformed instruction
  }
}

// ---- Text-to-speech (premium Edge-TTS "Ava", local speechSynthesis fallback) --
// Always on (no mute button — the bar stays slim). The audio-wave animation
// shows while a sentence is being spoken.
//
// Primary voice is Edge-TTS, synthesized in main (tts-engine.js) and STREAMED
// from the local server; an <audio> element plays chunks as they arrive, so it
// starts at first-chunk latency (not full-synthesis time). It's a free CLOUD
// call, so if it fails (offline / hiccup) we fall back to the local Windows voice.
//
// Look-ahead prefetch: while step N plays, step N+1's audio is downloaded into a
// complete Blob (walk.nextPrefetch), so the swap on 'ended' is instant AND starts
// cleanly from 0 (no clipped first syllable). speakStep(text, audio, onend) drives
// `onend` (which advances the walkthrough) off the audio actually ENDING — never a
// text-length estimate — so a sentence is never cut off. A
// monotonic token cancels stale events when a newer step starts or we stop.
const TTS_RATE = 1.05; // matches the old speechSynthesis pace
// Edge-TTS audio is STREAMED (progressive playback), so this gates only the time
// to the FIRST audio chunk — not full synthesis. Streaming plays the instant the
// first chunk lands, so a higher value adds NO delay on the happy path; it's only
// the "give up and use the local voice" threshold for an unreachable/dead stream.
// Independent of sentence length. 7s gives a slow/cold first request (handshake +
// Edge time-to-first-audio) room to land in Ava rather than prematurely falling
// back to the robotic voice. Streaming plays the instant the first chunk lands, so
// this higher value adds NO delay on the happy path.
const STREAM_START_TIMEOUT_MS = 7000;
// The local engine streams TTS here (mirrors local-server.js PORT 8788). An
// <audio> element pointed at this URL plays the MP3 as bytes arrive.
const TTS_STREAM_BASE = "http://localhost:8788/tts";
let currentAudio = null; // the <audio> element currently streaming Edge-TTS, if any
let speakToken = 0; // bumps on every speakStep()/stopSpeaking() so stale results no-op

// Diagnostics: log to the overlay's own console AND forward to the main process
// (terminal) so the whole TTS decision path is visible in one place while debugging.
function tlog(...a) {
  console.log("[overlay-tts]", ...a);
  try {
    if (window.lazyAI.ttsLog) {
      window.lazyAI.ttsLog(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    }
  } catch {}
}

function stopAudio() {
  if (currentAudio) {
    // Hard kill: mark as intentionally stopped (so the pending play() rejection is
    // swallowed, not surfaced as an error), then pause + abort the in-flight stream
    // (removeAttribute + load() closes the HTTP connection).
    currentAudio._killed = true;
    try { currentAudio.pause(); currentAudio.removeAttribute("src"); currentAudio.load(); } catch {}
    releaseAudio(currentAudio);
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// Free local Windows voice — the offline fallback. `done` is the single-fire
// settle() so the walkthrough advances exactly once.
function speakWithSpeechSynthesis(text, token, done) {
  tlog("speaking via local speechSynthesis (robotic fallback)");
  if (!window.speechSynthesis) { tlog("speechSynthesis unavailable — advancing silently"); done(); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = TTS_RATE;
  utterance.onstart = () => { if (token === speakToken) setSpeaking(true); };
  utterance.onend = () => { if (token === speakToken) { setSpeaking(false); done(); } };
  utterance.onerror = () => { if (token === speakToken) { setSpeaking(false); done(); } };
  window.speechSynthesis.speak(utterance);
}

function ttsUrl(text) {
  return `${TTS_STREAM_BASE}?rate=${encodeURIComponent(TTS_RATE)}&text=${encodeURIComponent(text)}`;
}

// Create a streaming <audio> for `text` for IMMEDIATE play (the first step, or when
// a prefetch isn't ready). Played right away with no pre-buffer, so it starts
// cleanly at 0. (Prefetched steps play a COMPLETE Blob instead — see startPrefetch.)
function makeTtsAudio(text) {
  if (!text) return null;
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = ttsUrl(text);
  return audio;
}

// Prefetch the NEXT step by fully downloading its audio into an in-memory Blob.
// Playing from a COMPLETE Blob starts cleanly at 0 — a pre-buffered *streaming*
// element resumes at its live edge and clips the first syllable — and makes the
// swap instant. `.url` becomes a blob: URL when ready; `.failed` on a download error.
function startPrefetch(text) {
  if (!text) return null;
  const holder = { url: null, failed: false, controller: new AbortController() };
  holder.promise = fetch(ttsUrl(text), { signal: holder.controller.signal })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
    .then((blob) => { holder.url = URL.createObjectURL(blob); })
    .catch((err) => {
      holder.failed = true;
      if (!err || err.name !== "AbortError") tlog("prefetch failed:", String((err && err.message) || err));
    });
  return holder;
}

function discardPrefetch(holder) {
  if (!holder) return;
  try { holder.controller.abort(); } catch {}
  if (holder.url) { try { URL.revokeObjectURL(holder.url); } catch {} holder.url = null; }
}

// Revoke the blob: URL backing a played audio element (prefetched steps), if any.
function releaseAudio(audio) {
  if (audio && audio._blobUrl) { try { URL.revokeObjectURL(audio._blobUrl); } catch {} audio._blobUrl = null; }
}

// If playback makes NO progress for this long (a real stall, or a dropped 'ended'),
// advance anyway so the walkthrough never hangs. It's re-armed on every progress
// tick, so it can never cut off audio that's still actually playing.
const STUCK_MS = 8000;

// Speak `text` for the current step using the (possibly prefetched + already
// buffered) `audio` element. Advancement is driven by the audio actually ENDING,
// so streamed Ava audio is never cut off mid-sentence. Falls back to the local
// Windows voice if the stream can't start/play. Always calls onend exactly once.
function speakStep(text, audio, onend, onStarted) {
  const token = ++speakToken;
  stopAudio(); // stop the previous step's audio + any utterance
  // Fire onStarted() exactly once, when this step has CLAIMED a voice/socket (Ava
  // 'playing', or a fallback). playStep uses it to DEFER the next step's prefetch
  // so the prefetch can't race ahead and starve this step's stream (the first-step
  // timeout-to-robotic bug).
  let startedNotified = false;
  const notifyStarted = () => { if (startedNotified) return; startedNotified = true; if (onStarted) onStarted(); };
  if (!text) { notifyStarted(); onend(); return; }

  let decided = false; // the first path to actually produce speech wins
  let started = false; // Ava audio has begun playing
  let settled = false;
  const settle = () => { if (settled) return; settled = true; onend(); };

  const useLocalVoice = (why) => {
    if (decided || token !== speakToken) return;
    decided = true;
    notifyStarted(); // settled on the local voice → free the socket for the prefetch
    tlog("falling back —", why);
    speakWithSpeechSynthesis(text, token, settle);
  };

  // A prefetch that already errored (or a missing element) → straight to fallback.
  if (!audio || audio.error) { useLocalVoice(audio ? "prefetch errored" : "no audio element"); return; }
  currentAudio = audio;
  // Detach this element and revoke its blob: URL (if prefetched) when it's done.
  const endAudio = () => { if (currentAudio === audio) currentAudio = null; releaseAudio(audio); };

  // (a) startTimer: nothing started playing → fall back. (b) stuckTimer: playback
  // stalled / 'ended' dropped → advance. Re-armed on each timeupdate so it never
  // pre-empts audio that's still progressing.
  let startTimer = setTimeout(() => {
    if (token !== speakToken) return;
    audio._killed = true; // intentional give-up → swallow the play() rejection
    try { audio.pause(); } catch {}
    useLocalVoice(`no audio within ${STREAM_START_TIMEOUT_MS}ms`);
  }, STREAM_START_TIMEOUT_MS);
  let stuckTimer = null;
  const armStuck = () => {
    clearTimeout(stuckTimer);
    stuckTimer = setTimeout(() => {
      if (token !== speakToken) return;
      tlog("playback stalled / no end event — advancing");
      endAudio();
      setSpeaking(false);
      settle();
    }, STUCK_MS);
  };
  const clearTimers = () => { clearTimeout(startTimer); clearTimeout(stuckTimer); };

  // 'playing' fires when audio actually begins — our "Ava started" signal.
  audio.addEventListener("playing", () => {
    if (token !== speakToken || started) return;
    if (decided) { try { audio.pause(); } catch {} return; } // already fell back — drop late stream
    started = true;
    decided = true;
    notifyStarted(); // Ava is now streaming → safe to prefetch the next step
    clearTimeout(startTimer);
    armStuck();
    tlog("Ava audio PLAYING ✓");
    setSpeaking(true);
  });

  // Progress observed → push the stall backstop out. While the audio keeps
  // playing this keeps re-arming, so the step only advances when it truly ends.
  audio.addEventListener("timeupdate", () => {
    if (token === speakToken && started) armStuck();
  });

  audio.addEventListener("ended", () => {
    if (token !== speakToken) return;
    clearTimers();
    tlog("Ava audio ended");
    setSpeaking(false);
    endAudio();
    settle();
  });

  audio.addEventListener("error", () => {
    if (audio._killed || token !== speakToken) return; // intentional stop → silent
    clearTimers();
    const er = audio.error;
    tlog("Ava audio ERROR:", er ? `code=${er.code} ${er.message || ""}` : "(unknown)");
    endAudio();
    setSpeaking(false);
    // Nothing played yet → robotic voice. A mid-stream drop after we started →
    // just finish the step (don't restart the sentence robotically).
    if (!started) useLocalVoice("stream error before playback"); else settle();
  });

  tlog(`speakStep token=${token}: "${text.slice(0, 48)}${text.length > 48 ? "…" : ""}"`);
  audio.play().then(
    () => tlog("audio.play() accepted"),
    (err) => {
      if (audio._killed || token !== speakToken || started) return; // intentional stop → silent
      clearTimeout(startTimer);
      tlog("audio.play() REJECTED:", String((err && err.message) || err));
      endAudio();
      useLocalVoice("play() rejected");
    }
  );
}

function stopSpeaking() {
  speakToken++; // invalidate any in-flight async speak
  setSpeaking(false);
  stopAudio();
}

// ---- Click-through overlay (Stage 4.4 prerequisite) -----------------------
// The window is click-through by default so annotations never trap the cursor —
// you keep using the app underneath. We flip it solid only while the pointer is
// over the control bar so its buttons/input work. (The status text is
// click-through, so it never traps the cursor.) enter/leave fire because main
// forwards mouse-move.
function setInteractive(on) {
  window.lazyAI.setIgnoreMouse(!on);
}
els.bar.addEventListener("mouseenter", () => setInteractive(true));
els.bar.addEventListener("mouseleave", () => setInteractive(false));

// ---- Cursor-follow for the floating status pill ---------------------------
// The "Planning…" status + audio-wave used to sit dead-center, covering whatever
// the user was looking at. Instead we float the glass pill just below-right of the
// cursor. The overlay is click-through with { forward: true }, so mousemove still
// fires here (the same mouse-forwarding the bar's enter/leave above already rely
// on) — no main-process change or new IPC needed. We smooth the motion with a lerp
// so it glides without jitter, and clamp it so the pill never clips off-screen.
const POINTER_OFFSET_X = 18; // px to the right of the cursor
const POINTER_OFFSET_Y = 22; // px below the cursor
const FOLLOW_EASE = 0.18; // 0→1 lerp factor; lower = floatier, higher = snappier
const pointer = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 }; // target
const floatPos = { x: pointer.x, y: pointer.y }; // smoothed (eased) position
let followRaf = 0;
let pointerSeeded = false; // jump to the first real cursor pos instead of gliding from center

document.addEventListener(
  "mousemove",
  (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!pointerSeeded) {
      floatPos.x = pointer.x;
      floatPos.y = pointer.y;
      pointerSeeded = true;
    }
  },
  { passive: true }
);

function followFrame() {
  floatPos.x += (pointer.x - floatPos.x) * FOLLOW_EASE;
  floatPos.y += (pointer.y - floatPos.y) * FOLLOW_EASE;
  const w = els.status.offsetWidth;
  const h = els.status.offsetHeight;
  // place below-right of the cursor, then keep the whole pill on-screen
  let x = floatPos.x + POINTER_OFFSET_X;
  let y = floatPos.y + POINTER_OFFSET_Y;
  x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
  y = Math.min(Math.max(8, y), window.innerHeight - h - 8);
  els.status.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  followRaf = requestAnimationFrame(followFrame);
}

function statusVisible() {
  return els.status.classList.contains("show") || els.status.classList.contains("speaking");
}

// Run the follow loop only while the pill is actually visible (called from
// setAnswer/setSpeaking, which toggle those classes). Avoids an idle rAF loop.
function syncFollowLoop() {
  if (statusVisible()) {
    if (!followRaf) followRaf = requestAnimationFrame(followFrame);
  } else if (followRaf) {
    cancelAnimationFrame(followRaf);
    followRaf = 0;
  }
}

// ---- Narrated walkthrough (Live Teach) ------------------------------------
// Plays the AI's steps in order: speak one sentence while ONLY that step's shape
// animates in and pulses; when the sentence ends, clear it and reveal the next.
// Nothing is shown upfront — each component appears as it's discussed.
const ENTRANCE_MS = 650; // how long a shape takes to draw itself in
// A step's shape must stay on screen at least this long, even if TTS ends/drops
// instantly. Windows speechSynthesis sometimes drops an utterance on a rapid
// cancel()+speak() and fires onend/onerror immediately — without this floor the
// step would flash past and its box would look "not shown" (the "2 of 6 missing"
// bug). Covers the entrance animation + a brief hold so every box is actually seen.
const MIN_STEP_MS = ENTRANCE_MS + 700;
let walk = null; // { steps, i, stepStart, raf, timer, done, accumulate, nextPrefetch } | null
let awaitingAction = false; // true while a guide step is up, waiting for the user to act

function renderStepFrame(now) {
  if (!walk) return;
  const step = walk.steps[walk.i];
  const elapsed = now - walk.stepStart;
  const progress = easeOut(Math.min(1, elapsed / ENTRANCE_MS));
  const pulse = 0.5 + 0.5 * Math.sin(elapsed / 430); // gentle breathing highlight
  clearCanvas();
  // In "accumulate" mode (math/derivations) earlier steps stay on screen and the
  // picture builds up. Otherwise each step REPLACES the last — only the current
  // step is shown (default, for navigation / how-to / coding / most explanations).
  if (walk.accumulate) {
    for (let k = 0; k < walk.i; k++) {
      for (const ins of walk.steps[k].draw || []) drawInstruction(ins, STATIC);
    }
  }
  for (const ins of step.draw || []) drawInstruction(ins, { progress, pulse, alpha: 1 });
  walk.raf = requestAnimationFrame(renderStepFrame);
}

function playStep() {
  if (!walk) return;
  const step = walk.steps[walk.i];
  walk.stepStart = performance.now();

  // No subtitle — both modes are audio-only. Only "Planning…" (status) and the
  // audio-wave (while speaking) are ever shown.

  cancelAnimationFrame(walk.raf);
  walk.raf = requestAnimationFrame(renderStepFrame);

  // advance() runs when the step's audio ENDS (or its stall/fallback fires). It's
  // guarded so a stale call on a superseded step no-ops, and it holds each step for
  // at least MIN_STEP_MS so its shape is actually seen.
  const myWalk = walk;
  const myIndex = walk.i;
  const advance = () => {
    if (walk !== myWalk || walk.i !== myIndex) return;
    const elapsed = performance.now() - walk.stepStart;
    if (elapsed < MIN_STEP_MS) {
      clearTimeout(walk.timer);
      walk.timer = setTimeout(advance, MIN_STEP_MS - elapsed);
      return;
    }
    nextStep();
  };

  // Prefer the fully-downloaded Blob we prefetched during the previous step: it
  // plays cleanly from 0 (a pre-buffered *streaming* element resumes at its live
  // edge and clips the first syllable) and the swap is instant. If it isn't ready
  // (first step, or not finished in time), stream this step live — a fresh element
  // played immediately also starts cleanly.
  const pf = walk.nextPrefetch;
  walk.nextPrefetch = null;
  let audio;
  if (pf && pf.url) {
    audio = new Audio(pf.url);
    audio._blobUrl = pf.url; // own it → revoked when the step ends
  } else {
    if (pf) discardPrefetch(pf); // wasn't ready in time — drop it, stream live
    audio = makeTtsAudio(step.say);
  }
  // LOOK-AHEAD, but ONLY once THIS step has claimed the socket/voice (onStarted) —
  // starting the next prefetch any earlier lets it race ahead on the shared Edge-TTS
  // connection and starve the live-streamed first step, which then times out to the
  // robotic voice. So defer the prefetch to onStarted rather than firing it here.
  const prefetchNext = () => {
    if (walk !== myWalk || walk.i !== myIndex) return;
    const next = walk.steps[walk.i + 1];
    walk.nextPrefetch = next ? startPrefetch(next.say) : null;
  };
  speakStep(step.say, audio, advance, prefetchNext);
}

function nextStep() {
  if (!walk) return;
  clearTimeout(walk.timer);
  walk.i += 1;
  if (walk.i >= walk.steps.length) {
    finishWalkthrough();
    return;
  }
  playStep();
}

// After the last sentence: stop animating but leave the final state on screen
// (static, no pulse). In accumulate mode that's the fully built-up picture; in
// default mode it's just the last step. Audio only; no text caption.
function finishWalkthrough() {
  if (!walk) return;
  cancelAnimationFrame(walk.raf);
  clearTimeout(walk.timer);
  const steps = walk.steps;
  const accumulate = walk.accumulate;
  clearCanvas();
  const resting = accumulate ? steps : [steps[steps.length - 1]];
  for (const s of resting) {
    for (const ins of s.draw || []) drawInstruction(ins, STATIC);
  }
  walk = null;
}

// Abort the current walkthrough without reporting a natural finish.
function stopWalkthrough() {
  if (walk) {
    cancelAnimationFrame(walk.raf);
    clearTimeout(walk.timer);
    // Clear the prefetch cache (Stop/Next/interruption) so we never swap to a
    // now-stale step's audio; this also aborts an in-flight prefetch download.
    discardPrefetch(walk.nextPrefetch);
    walk.nextPrefetch = null;
    walk = null;
  }
  awaitingAction = false;
  stopSpeaking();
  // Hard-kill the engine's Edge-TTS connection too: a stale in-flight prefetch
  // (still streaming on the shared socket) would otherwise starve the next
  // request. No-op in the engine when nothing is in flight.
  if (window.lazyAI.ttsReset) window.lazyAI.ttsReset();
}

function startWalkthrough(steps, done = true, accumulate = false) {
  stopWalkthrough();
  // While guiding (done:false) the bar's button means "I've done it, continue"
  // — a manual fallback in case auto-detection ever misses the action.
  awaitingAction = !done;
  els.askBtn.title = done ? "Ask" : "Continue"; // icon-only send button; title gives context
  clearCanvas();
  setAnswer("", ""); // audio only — hide the "Looking…" status; no narration subtitle
  walk = { steps, i: 0, stepStart: 0, raf: 0, timer: 0, done, accumulate, nextPrefetch: null };
  playStep();
}

// "I've done that step" — advance the guide manually (fallback for when the
// screen-change watcher misses it, or the user acted mid-narration).
function manualContinue() {
  awaitingAction = false;
  stopWalkthrough();
  els.askBtn.title = "Ask";
  clearCanvas();
  setAnswer("Looking at your screen…", "loading");
  window.lazyAI.guideContinue();
}

// ---- Guide loop wiring (main drives capture/ask; we play + report back) ----
// Main pushes each turn's walkthrough here.
window.lazyAI.onPlaySteps((data) => {
  if (data.imageWidth && data.imageHeight && (data.imageWidth !== imageWidth || data.imageHeight !== imageHeight)) {
    imageWidth = data.imageWidth;
    imageHeight = data.imageHeight;
    resizeCanvas();
  }
  els.askBtn.disabled = false;
  const steps = data.steps && data.steps.length ? data.steps : [{ say: "Done.", draw: [] }];
  startWalkthrough(steps, data.done !== false, data.accumulate === true); // undefined → done, replace
  if (overlayMode === "control") els.askBtn.title = "Do it"; // keep control-mode label
});

// Loading / error / hint captions from the loop.
window.lazyAI.onGuideStatus((data) => {
  setAnswer(data.text || "", data.kind || "");
  if (data.kind === "err") els.askBtn.disabled = false;
});

// Main is about to re-capture a clean screenshot — wipe our annotation first.
window.lazyAI.onOverlayClear(() => {
  stopWalkthrough();
  clearCanvas();
});

// ---- Flow -----------------------------------------------------------------
// Hand the goal to main, which captures, asks, plays the step here, and keeps
// guiding (watching the screen for the user to act) until the task is done.
function ask() {
  els.askBtn.disabled = true;
  els.askBtn.title = overlayMode === "control" ? "Do it" : "Ask";
  stopWalkthrough();
  clearCanvas();
  setAnswer("Looking at your screen…", "loading");
  const text = els.question.value.trim();
  if (overlayMode === "control") window.lazyAI.startControl(text);
  else window.lazyAI.startGuide(text);
}

// ---- Voice input (click OR push-to-talk → local Whisper, auto-submit) -------
// Two ways in, same flow: CLICK the mic to toggle recording on/off, or HOLD Right
// Alt (release to stop). Stopping transcribes + submits automatically — no Enter.
// A live wave fills the input while listening (see setListening). Works for BOTH
// DeskTutor and DeskPilot — stop routes to ask() → startGuide/startControl.
const MIC_IDLE_TITLE = "Click to speak — or hold Right Alt";
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recording = false; // true from the moment we begin acquiring the mic
let stopRequested = false; // a release that landed before the recorder was ready

// Toggle the "listening" UI: the in-field wave, the mic's active state, and the
// floating "Listening…" pill — nothing instructional.
function setListening(on) {
  els.bar.classList.toggle("listening", on);
  els.micBtn.classList.toggle("recording", on);
  els.micBtn.title = on ? "Listening…" : MIC_IDLE_TITLE;
  if (on) setAnswer("Listening…", "loading");
}

async function startRecording() {
  if (recording) return; // ignore key auto-repeat / double triggers
  // Smart interruption + clean slate (#3/#4): if Ava is mid-sentence or a guide is
  // up, kill the audio + annotations and reset input so this is a brand-new request
  // — and re-enable Send in case a prior flow left it disabled (the deadlock).
  stopWalkthrough();
  clearCanvas();
  awaitingAction = false;
  els.askBtn.disabled = false;
  els.askBtn.title = overlayMode === "control" ? "Do it" : "Ask";
  recording = true;
  stopRequested = false;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    recording = false;
    setListening(false);
    setAnswer("Microphone access failed: " + (err?.message || err), "err");
    return;
  }
  // A release can land while we're still acquiring the mic — honor it.
  if (stopRequested) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
    recording = false;
    setListening(false);
    return;
  }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(audioStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  setListening(true);
}

function stopRecording() {
  if (!recording) return;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop(); // → onRecordingStop
  } else {
    stopRequested = true; // recorder not ready yet — bail out once it is
  }
}

async function onRecordingStop() {
  recording = false;
  setListening(false);
  if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
  audioStream = null;

  const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (!blob.size) {
    setAnswer("No audio captured — try again.", "err");
    return;
  }
  // No "Transcribing…" status: the model is bundled (no download) and fast, and
  // we auto-submit — so clear the pill and go straight to the ask for an instant feel.
  setAnswer("", "");
  try {
    const audio = await blobTo16kMono(blob);
    const result = await window.lazyAI.transcribe(audio);
    if (!result.ok) {
      setAnswer("Transcription failed: " + result.error, "err");
      return;
    }
    const text = (result.text || "").trim();
    els.question.value = text;
    if (text) ask(); // got speech → ask/act straight away
    else setAnswer("Didn't catch that — try again.", "err");
  } catch (err) {
    setAnswer("Audio processing error: " + (err?.message || err), "err");
  }
}

// Decode the recorded clip and resample to 16 kHz mono — what Whisper expects.
async function blobTo16kMono(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmpCtx = new AC();
  const decoded = await tmpCtx.decodeAudioData(arrayBuffer);
  await tmpCtx.close();
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0); // Float32Array @ 16 kHz, mono
}

// Dual-mode mic: CLICK the button to toggle recording, OR hold Right Alt (release
// to stop). Both drive the same startRecording / stopRecording flow.
els.micBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});
document.addEventListener("keydown", (e) => {
  if (e.code === "AltRight" && !e.repeat) { e.preventDefault(); startRecording(); }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "AltRight") { e.preventDefault(); stopRecording(); }
});
// If the overlay loses focus while the key is held, keyup may never arrive —
// stop so we don't record indefinitely.
window.addEventListener("blur", () => { if (recording) stopRecording(); });

// While a guide step is waiting, an empty Ask/Enter means "I've done it, continue".
function askOrContinue() {
  if (awaitingAction && !els.question.value.trim()) manualContinue();
  else ask();
}
els.askBtn.addEventListener("click", askOrContinue);
els.question.addEventListener("keydown", (e) => {
  if (e.key === "Enter") askOrContinue();
});
els.closeBtn.addEventListener("click", () => {
  stopWalkthrough();
  window.lazyAI.hideOverlay();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    stopWalkthrough();
    window.lazyAI.hideOverlay();
  }
});

// Main tells us the screenshot's pixel size each time the overlay is summoned.
window.lazyAI.onOverlayShow((data) => {
  imageWidth = data?.imageWidth || window.innerWidth;
  imageHeight = data?.imageHeight || window.innerHeight;
  overlayMode = data?.mode === "control" ? "control" : "teach";
  stopWalkthrough();
  resizeCanvas();
  clearCanvas();
  setAnswer("", "");
  els.askBtn.disabled = false; // fresh summon → never inherit a disabled Send button
  // Reflect the mode in the bar so it's obvious whether it will ACT or EXPLAIN.
  if (barTitle) barTitle.innerHTML = overlayMode === "control" ? "Desk<b>Pilot</b>" : "Desk<b>Tutor</b>";
  els.askBtn.title = overlayMode === "control" ? "Do it" : "Ask";
  els.question.placeholder =
    overlayMode === "control"
      ? "tell me what to do… e.g. “click the Send button”, “open Notepad” (Enter, Esc to cancel)"
      : "ask about what's on your screen… (Enter to ask, Esc to close)";
  els.question.value = "";
  els.question.focus();
});

resizeCanvas();
