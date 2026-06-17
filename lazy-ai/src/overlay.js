// Screen Teacher overlay (renderer). Sizes the canvas to the screenshot,
// sends the user's question to the main process, and renders the AI's
// [DRAW:...] instructions onto the transparent canvas over the live screen.

const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");
const els = {
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
const ACCENT = "#6d7cff";
const LABEL_BG = "rgba(109, 124, 255, 0.92)";
// Line width scales with image size so HiDPI screenshots don't render hairlines.
const STROKE = Math.max(4, Math.round(imageWidth / 480));

function styleStroke() {
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = STROKE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function drawLabel(x, y, text) {
  if (!text) return;
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
}

function drawArrow(from, to, label) {
  styleStroke();
  const [x1, y1] = from;
  const [x2, y2] = to;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  // arrowhead
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = STROKE * 4;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  if (label) drawLabel(x1, y1 - 10, label);
}

function drawBox(x, y, w, h, label) {
  styleStroke();
  ctx.strokeRect(x, y, w, h);
  if (label) drawLabel(x, y - 6, label);
}

function drawCircle(cx, cy, r, label) {
  styleStroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (label) drawLabel(cx - r, cy - r - 6, label);
}

function drawLine(from, to) {
  styleStroke();
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
}

function render(instructions) {
  clearCanvas();
  for (const ins of instructions || []) {
    try {
      switch (ins.shape) {
        case "arrow": drawArrow(ins.from, ins.to, ins.label); break;
        case "box": drawBox(ins.x, ins.y, ins.w, ins.h, ins.label); break;
        case "circle": drawCircle(ins.x, ins.y, ins.r, ins.label); break;
        case "line": drawLine(ins.from, ins.to); break;
        case "label": drawLabel(ins.x, ins.y, ins.text); break;
      }
    } catch {
      // ignore a single malformed instruction
    }
  }
}

// ---- Text-to-speech (free, local Windows voice via speechSynthesis) -------
let ttsEnabled = localStorage.getItem("lazyTts") !== "off"; // default on

function updateTtsButton() {
  els.ttsBtn.textContent = ttsEnabled ? "🔊" : "🔇";
  els.ttsBtn.title = ttsEnabled ? "Speech on — click to mute" : "Speech off — click to unmute";
}

function speak(text) {
  if (!ttsEnabled || !text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // never overlap with a previous answer
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
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

// ---- Flow -----------------------------------------------------------------
async function ask() {
  const question = els.question.value.trim();
  els.askBtn.disabled = true;
  stopSpeaking();
  clearCanvas();
  setAnswer("Looking at your screen…", "loading");

  const result = await window.lazyAI.askScreen(question);
  els.askBtn.disabled = false;

  if (result.ok) {
    render(result.instructions);
    setAnswer(result.explanation || "Done.", "");
    speak(result.explanation || ""); // read the answer aloud
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
  stopSpeaking();
  window.lazyAI.hideOverlay();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    stopSpeaking();
    window.lazyAI.hideOverlay();
  }
});

// Main tells us the screenshot's pixel size each time the overlay is summoned.
window.lazyAI.onOverlayShow((data) => {
  imageWidth = data?.imageWidth || window.innerWidth;
  imageHeight = data?.imageHeight || window.innerHeight;
  stopSpeaking();
  resizeCanvas();
  clearCanvas();
  setAnswer("", "");
  els.question.value = "";
  els.question.focus();
});

resizeCanvas();
