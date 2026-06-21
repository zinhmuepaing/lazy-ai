// Renderer (UI logic). Runs in the page. Talks to the main process only
// through the safe window.lazyAI bridge defined in preload.js.

const els = {
  prompt: document.getElementById("prompt"),
  context: document.getElementById("context"),
  contextBtn: document.getElementById("contextBtn"),
  modelDD: document.getElementById("modelDD"),
  modelTrigger: document.getElementById("modelTrigger"),
  modelTriggerIc: document.getElementById("modelTriggerIc"),
  modelTriggerName: document.getElementById("modelTriggerName"),
  modelMenu: document.getElementById("modelMenu"),
  fileBtn: document.getElementById("fileBtn"),
  fileChip: document.getElementById("fileChip"),
  fileName: document.getElementById("fileName"),
  fileRemove: document.getElementById("fileRemove"),
  sendBtn: document.getElementById("sendBtn"),
  result: document.getElementById("result"),
  output: document.getElementById("output"),
  copyBtn: document.getElementById("copyBtn"),
  useBtn: document.getElementById("useBtn"),
  repeatBtn: document.getElementById("repeatBtn"),
  status: document.getElementById("status"),
  closeBtn: document.getElementById("closeBtn"),
};

// ---- Summon-popup behaviour (Stage 3) ------------------------------------
// Dismiss with Esc or the close button; focus the prompt box each time we're shown,
// prefilled with whatever text was selected in the app the user came from.
els.closeBtn.addEventListener("click", () => window.lazyAI.hideWindow());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.lazyAI.hideWindow();
});
window.lazyAI.onShow((data) => {
  if (data.selectionText && data.selectionText.trim()) {
    els.prompt.value = data.selectionText;
    autoGrow(els.prompt);
  }
  els.prompt.focus();
  els.prompt.select();
});

// Holds the parsed text of the attached file, if any.
let attachedFile = null; // { name, text }

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// Auto-grow the prompt textarea so the composer hugs its content.
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 210) + "px";
}
els.prompt.addEventListener("input", () => autoGrow(els.prompt));

// ---- Model picker (custom dropdown with provider icons) -------------------
// Native <option> can't render an icon, so we build a small dropdown whose items
// each show the provider's brand mark (Anthropic / Gemini / OpenAI).
let selectedModelId = null;

let geminiGradSeq = 0;
function providerIconSVG(key) {
  const k = (key || "").toLowerCase();
  if (k.includes("gemini")) {
    const id = "gem-grad-" + geminiGradSeq++; // unique so multiple Gemini icons each get the gradient
    return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="${id}" x1="0%" x2="68.73%" y1="100%" y2="30.395%"><stop offset="0%" stop-color="#1C7DFF"/><stop offset="52.021%" stop-color="#1C69FF"/><stop offset="100%" stop-color="#F0DCD6"/></linearGradient></defs><path d="M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12" fill="url(#${id})" fill-rule="nonzero"/></svg>`;
  }
  if (k.includes("gpt") || k.includes("openai")) {
    return `<svg viewBox="0 0 256 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="#1d1d1f"><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/></svg>`;
  }
  // default → Anthropic (Claude / Haiku)
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="#1d1d1f" fill-rule="evenodd"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>`;
}

const CHECK_SVG =
  '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function setModelMenuOpen(open) {
  els.modelMenu.hidden = !open;
  els.modelTrigger.setAttribute("aria-expanded", String(open));
}

function selectModel(id, label) {
  selectedModelId = id;
  els.modelTriggerIc.innerHTML = providerIconSVG(id + " " + label);
  els.modelTriggerName.textContent = label;
  for (const item of els.modelMenu.querySelectorAll(".model-item")) {
    item.classList.toggle("selected", item.dataset.id === id);
  }
}

// Populate the model picker from the main process registry (Haiku / Gemini / OpenAI).
async function loadModels() {
  const { models, defaultModel } = await window.lazyAI.getModels();
  els.modelMenu.innerHTML = "";
  const entries = Object.entries(models);
  for (const [id, info] of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.dataset.id = id;
    item.setAttribute("role", "option");
    item.innerHTML =
      `<span class="menu-ic">${providerIconSVG(id + " " + info.label)}</span>` +
      `<span class="model-label">${info.label}</span>` +
      CHECK_SVG;
    item.addEventListener("click", () => {
      selectModel(id, info.label);
      setModelMenuOpen(false);
    });
    els.modelMenu.appendChild(item);
  }
  const initial = (defaultModel && models[defaultModel]) ? defaultModel : entries[0]?.[0];
  if (initial) selectModel(initial, models[initial].label);
}

els.modelTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  setModelMenuOpen(els.modelMenu.hidden);
});
document.addEventListener("click", (e) => {
  if (!els.modelDD.contains(e.target)) setModelMenuOpen(false);
});

// ---- Context / style toggle ----------------------------------------------
els.contextBtn.addEventListener("click", () => {
  const show = els.context.hidden;
  els.context.hidden = !show;
  els.contextBtn.classList.toggle("active", show);
  els.contextBtn.setAttribute("aria-pressed", String(show));
  if (show) els.context.focus();
});

// ---- File attach ("+") ----------------------------------------------------
els.fileBtn.addEventListener("click", async () => {
  const result = await window.lazyAI.pickFile();
  if (!result) return; // cancelled
  if (result.error) {
    clearFile();
    setStatus(`Couldn't read ${result.name}: ${result.error}`, "err");
    return;
  }
  attachedFile = result;
  els.fileName.textContent = result.name;
  els.fileChip.hidden = false;
  setStatus("");
});

function clearFile() {
  attachedFile = null;
  els.fileName.textContent = "";
  els.fileChip.hidden = true;
}
els.fileRemove.addEventListener("click", clearFile);

// ---- Polish flow ----------------------------------------------------------
async function runPolish() {
  const promptText = els.prompt.value.trim();
  if (!promptText) {
    setStatus("Type a prompt first.", "err");
    return;
  }

  els.sendBtn.disabled = true;
  els.repeatBtn.disabled = true;
  els.useBtn.disabled = true;
  els.copyBtn.disabled = true;
  setStatus("Polishing…", "loading");

  const result = await window.lazyAI.polish({
    modelId: selectedModelId,
    promptText,
    context: els.context.value,
    fileName: attachedFile?.name,
    fileText: attachedFile?.text,
    fileImage: attachedFile?.image, // { base64, mediaType } when an image was attached
  });

  els.sendBtn.disabled = false;

  if (result.ok) {
    els.result.hidden = false;
    els.output.value = result.text;
    els.useBtn.disabled = false;
    els.copyBtn.disabled = false;
    els.repeatBtn.disabled = false;
    setStatus("Done. Use it, or copy.", "ok");
    els.output.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    setStatus(result.error, "err");
  }
}

// Send button polishes. Enter sends; Shift+Enter inserts a newline.
els.sendBtn.addEventListener("click", runPolish);
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runPolish();
  }
});

// Repeat — polish the input again for a fresh result.
els.repeatBtn.addEventListener("click", runPolish);

// Copy button.
els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.output.value);
  setStatus("Copied to clipboard.", "ok");
});

// "Use" — hand the result to the main process, which restores the source app
// and sends Ctrl+V. The popup hides as part of that.
els.useBtn.addEventListener("click", () => {
  if (!els.output.value) return;
  window.lazyAI.pasteResult(els.output.value);
});

loadModels();
window.lazyAI.onSettingsUpdated(loadModels); // re-sync default model after Settings save

// ---- Hero typing animation (cycles taglines under the logo) ---------------
// Types out, holds, erases, and moves to the next phrase — looping forever.
// Pure setTimeout chain (no library); writes plain text into #typed while the
// CSS caret blinks beside it.
(function runTypingAnimation() {
  const el = document.getElementById("typed");
  if (!el) return;
  const PHRASES = [
    "Meet Lizzie...",
    "Understands everything on your screen",
    "Your autopilot for executing tasks",
  ];
  const TYPE_MS = 55; // per character while typing
  const ERASE_MS = 28; // per character while erasing
  const HOLD_MS = 1600; // pause once a phrase is fully typed
  const GAP_MS = 350; // pause after erasing, before the next phrase

  let phrase = 0;
  let chars = 0;
  let erasing = false;

  function tick() {
    const text = PHRASES[phrase];
    if (!erasing) {
      chars += 1;
      el.textContent = text.slice(0, chars);
      if (chars >= text.length) {
        erasing = true;
        setTimeout(tick, HOLD_MS);
      } else {
        setTimeout(tick, TYPE_MS);
      }
    } else {
      chars -= 1;
      el.textContent = text.slice(0, Math.max(0, chars));
      if (chars <= 0) {
        erasing = false;
        phrase = (phrase + 1) % PHRASES.length;
        setTimeout(tick, GAP_MS);
      } else {
        setTimeout(tick, ERASE_MS);
      }
    }
  }
  tick();
})();
