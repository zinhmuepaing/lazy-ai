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
}

function setSpeaking(on) {
  els.status.classList.toggle("speaking", on);
}

// ---- Drawing primitives (coordinates are screenshot pixels) ---------------
// Every shape is drawn through an `anim` object so the walkthrough can reveal it
// over time: { progress 0→1 (entrance), pulse 0→1 (breathing glow), alpha }.
const ACCENT = "#6d7cff";
const LABEL_BG = "rgba(109, 124, 255, 0.96)";

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
      case "box": drawBox(ins.x, ins.y, ins.w, ins.h, ins.label, a); break;
      case "circle": drawCircle(ins.x, ins.y, ins.r, ins.label, a); break;
      case "line": drawLine(ins.from, ins.to, a); break;
      case "label": drawLabel(ins.x, ins.y, ins.text, a.alpha * a.progress); break;
    }
  } catch {
    // ignore a single malformed instruction
  }
}

// ---- Text-to-speech (free, local Windows voice via speechSynthesis) -------
// Always on (no mute button — the bar stays slim). The audio-wave animation
// shows while a sentence is being spoken.
function speakStep(text, onend) {
  if (!text || !window.speechSynthesis) return false;
  window.speechSynthesis.cancel(); // never overlap with the previous sentence
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onstart = () => setSpeaking(true);
  utterance.onend = () => { setSpeaking(false); onend(); };
  utterance.onerror = () => { setSpeaking(false); onend(); }; // don't stall on a hiccup
  window.speechSynthesis.speak(utterance);
  return true;
}

function stopSpeaking() {
  setSpeaking(false);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
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

// ---- Narrated walkthrough (Live Teach) ------------------------------------
// Plays the AI's steps in order: speak one sentence while ONLY that step's shape
// animates in and pulses; when the sentence ends, clear it and reveal the next.
// Nothing is shown upfront — each component appears as it's discussed.
const ENTRANCE_MS = 650; // how long a shape takes to draw itself in
let walk = null; // { steps, i, stepStart, raf, timer, done } | null
let awaitingAction = false; // true while a guide step is up, waiting for the user to act

// When TTS is muted/unavailable, estimate how long the sentence would take to
// read so the visuals still pace themselves (~170 wpm), with sane bounds.
function estimateDurationMs(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.min(9000, Math.max(2000, words * 350 + 600));
}

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

  // Guard against a stale utterance/timer advancing a newer walkthrough; the
  // guard also makes the onend + safety-timer pair idempotent (whichever fires
  // first advances; the second sees a changed index and no-ops).
  const myWalk = walk;
  const myIndex = walk.i;
  const advance = () => {
    if (walk === myWalk && walk.i === myIndex) nextStep();
  };

  const estimate = estimateDurationMs(step.say);
  if (speakStep(step.say, advance)) {
    // Speaking: advance on onend, but keep a safety net — some Windows voices
    // drop the onend event, which would otherwise stall the walkthrough.
    walk.timer = setTimeout(advance, estimate + 4000);
  } else {
    // Muted/unavailable: pace purely on the estimated reading time.
    walk.timer = setTimeout(advance, estimate);
  }
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
    walk = null;
  }
  awaitingAction = false;
  stopSpeaking();
}

function startWalkthrough(steps, done = true, accumulate = false) {
  stopWalkthrough();
  // While guiding (done:false) the bar's button means "I've done it, continue"
  // — a manual fallback in case auto-detection ever misses the action.
  awaitingAction = !done;
  els.askBtn.textContent = done ? "Ask" : "Next ▶";
  clearCanvas();
  setAnswer("", ""); // audio only — hide the "Looking…" status; no narration subtitle
  walk = { steps, i: 0, stepStart: 0, raf: 0, timer: 0, done, accumulate };
  playStep();
}

// "I've done that step" — advance the guide manually (fallback for when the
// screen-change watcher misses it, or the user acted mid-narration).
function manualContinue() {
  awaitingAction = false;
  stopWalkthrough();
  els.askBtn.textContent = "Ask";
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
  if (overlayMode === "control") els.askBtn.textContent = "Do it"; // keep control-mode label
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
  els.askBtn.textContent = overlayMode === "control" ? "Do it" : "Ask";
  stopWalkthrough();
  clearCanvas();
  setAnswer("Looking at your screen…", "loading");
  const text = els.question.value.trim();
  if (overlayMode === "control") window.lazyAI.startControl(text);
  else window.lazyAI.startGuide(text);
}

// ---- Voice input (push-to-talk, local Whisper) ----------------------------
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;

async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setAnswer("Microphone access failed: " + (err?.message || err), "err");
    return;
  }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(audioStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  els.micBtn.classList.add("recording");
  els.micBtn.textContent = "⏹";
  setAnswer("Listening… click ⏹ when you're done speaking.", "loading");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
}

async function onRecordingStop() {
  els.micBtn.classList.remove("recording");
  els.micBtn.textContent = "🎤";
  if (audioStream) audioStream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (!blob.size) {
    setAnswer("No audio captured — try again.", "err");
    return;
  }
  setAnswer("Transcribing… (the first time downloads the speech model, ~140 MB)", "loading");
  try {
    const audio = await blobTo16kMono(blob);
    const result = await window.lazyAI.transcribe(audio);
    if (!result.ok) {
      setAnswer("Transcription failed: " + result.error, "err");
      return;
    }
    const text = (result.text || "").trim();
    els.question.value = text;
    if (text) ask(); // got speech → ask straight away
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

els.micBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});

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
  // Reflect the mode in the bar so it's obvious whether it will ACT or EXPLAIN.
  if (barTitle) barTitle.innerHTML = overlayMode === "control" ? "Screen<b>Control</b>" : "Screen<b>Teacher</b>";
  els.askBtn.textContent = overlayMode === "control" ? "Do it" : "Ask";
  els.question.placeholder =
    overlayMode === "control"
      ? "tell me what to do… e.g. “click the Send button”, “open Notepad” (Enter, Esc to cancel)"
      : "ask about what's on your screen… (Enter to ask, Esc to close)";
  els.question.value = "";
  els.question.focus();
});

resizeCanvas();
