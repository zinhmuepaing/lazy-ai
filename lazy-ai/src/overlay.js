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
  ttsBtn: document.getElementById("ttsBtn"),
  closeBtn: document.getElementById("closeBtn"),
  answer: document.getElementById("answer"),
};

// Canvas internal resolution = screenshot pixels, so AI coordinates (which map
// 1:1 to screenshot pixels) can be drawn without any scaling. CSS stretches the
// canvas to fill the screen.
let imageWidth = window.innerWidth;
let imageHeight = window.innerHeight;

function resizeCanvas() {
  canvas.width = imageWidth;
  canvas.height = imageHeight;
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function setAnswer(text, kind = "") {
  els.answer.textContent = text;
  els.answer.className = (text ? "show" : "") + (kind ? " " + kind : "");
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
let ttsEnabled = localStorage.getItem("lazyTts") !== "off"; // default on

function updateTtsButton() {
  els.ttsBtn.textContent = ttsEnabled ? "🔊" : "🔇";
  els.ttsBtn.title = ttsEnabled ? "Speech on — click to mute" : "Speech off — click to unmute";
}

// Speak one step's sentence; call `onend` when it finishes (or can't be spoken),
// so the walkthrough advances in time with the voice.
function speakStep(text, onend) {
  if (!ttsEnabled || !text || !window.speechSynthesis) return false;
  window.speechSynthesis.cancel(); // never overlap with the previous sentence
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onend = onend;
  utterance.onerror = onend; // don't stall the walkthrough if TTS hiccups
  window.speechSynthesis.speak(utterance);
  return true;
}

function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

els.ttsBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  localStorage.setItem("lazyTts", ttsEnabled ? "on" : "off");
  updateTtsButton();
  if (!ttsEnabled) stopSpeaking();
});
updateTtsButton();

// ---- Click-through overlay (Stage 4.4 prerequisite) -----------------------
// The window is click-through by default so annotations never trap the cursor —
// you keep using the app underneath. We flip it solid only while the pointer is
// over an interactive panel (the control bar or the answer box), so its
// buttons/input still work. enter/leave fire because main forwards mouse-move.
function setInteractive(on) {
  window.lazyAI.setIgnoreMouse(!on);
}
for (const panel of [els.bar, els.answer]) {
  panel.addEventListener("mouseenter", () => setInteractive(true));
  panel.addEventListener("mouseleave", () => setInteractive(false));
}

// ---- Narrated walkthrough (Live Teach) ------------------------------------
// Plays the AI's steps in order: speak one sentence while ONLY that step's shape
// animates in and pulses; when the sentence ends, clear it and reveal the next.
// Nothing is shown upfront — each component appears as it's discussed.
const ENTRANCE_MS = 650; // how long a shape takes to draw itself in
let walk = null; // { steps, i, stepStart, raf, timer } | null

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
  for (const ins of step.draw || []) drawInstruction(ins, { progress, pulse, alpha: 1 });
  walk.raf = requestAnimationFrame(renderStepFrame);
}

function playStep() {
  if (!walk) return;
  const step = walk.steps[walk.i];
  walk.stepStart = performance.now();
  setAnswer(step.say || "", ""); // synced caption under the bar

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

// After the last sentence: stop animating but leave that final shape on screen
// (static, no pulse) and show the whole explanation as a resting recap.
function finishWalkthrough() {
  if (!walk) return;
  cancelAnimationFrame(walk.raf);
  clearTimeout(walk.timer);
  const last = walk.steps[walk.steps.length - 1];
  clearCanvas();
  for (const ins of last.draw || []) drawInstruction(ins, STATIC);
  const recap = walk.steps.map((s) => s.say).filter(Boolean).join(" ");
  walk = null;
  if (recap) setAnswer(recap, "");
}

function stopWalkthrough() {
  if (walk) {
    cancelAnimationFrame(walk.raf);
    clearTimeout(walk.timer);
    walk = null;
  }
  stopSpeaking();
}

function startWalkthrough(steps) {
  stopWalkthrough();
  clearCanvas();
  walk = { steps, i: 0, stepStart: 0, raf: 0, timer: 0 };
  playStep();
}

// ---- Flow -----------------------------------------------------------------
async function ask() {
  const question = els.question.value.trim();
  els.askBtn.disabled = true;
  stopWalkthrough();
  clearCanvas();
  setAnswer("Looking at your screen…", "loading");

  const result = await window.lazyAI.askScreen(question);
  els.askBtn.disabled = false;

  if (result.ok) {
    const steps =
      result.steps && result.steps.length
        ? result.steps
        : [{ say: result.explanation || "Done.", draw: [] }];
    startWalkthrough(steps);
  } else {
    setAnswer(result.error || "Something went wrong.", "err");
  }
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

els.askBtn.addEventListener("click", ask);
els.question.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ask();
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
  stopWalkthrough();
  resizeCanvas();
  clearCanvas();
  setAnswer("", "");
  els.question.value = "";
  els.question.focus();
});

resizeCanvas();
