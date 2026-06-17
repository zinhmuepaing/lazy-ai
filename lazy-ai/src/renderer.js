// Renderer (UI logic). Runs in the page. Talks to the main process only
// through the safe window.lazyAI bridge defined in preload.js.

const els = {
  prompt: document.getElementById("prompt"),
  context: document.getElementById("context"),
  model: document.getElementById("model"),
  fileBtn: document.getElementById("fileBtn"),
  fileName: document.getElementById("fileName"),
  polishBtn: document.getElementById("polishBtn"),
  output: document.getElementById("output"),
  copyBtn: document.getElementById("copyBtn"),
  status: document.getElementById("status"),
};

// Holds the parsed text of the attached file, if any.
let attachedFile = null; // { name, text }

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// Populate the model dropdown from the main process registry.
async function loadModels() {
  const { models, defaultModel } = await window.lazyAI.getModels();
  els.model.innerHTML = "";
  for (const [id, info] of Object.entries(models)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    if (id === defaultModel) opt.selected = true;
    els.model.appendChild(opt);
  }
}

// Attach file button.
els.fileBtn.addEventListener("click", async () => {
  const result = await window.lazyAI.pickFile();
  if (!result) return; // cancelled
  if (result.error) {
    attachedFile = null;
    els.fileName.textContent = "";
    setStatus(`Couldn't read ${result.name}: ${result.error}`, "err");
    return;
  }
  attachedFile = result;
  els.fileName.textContent = `📎 ${result.name}`;
  setStatus("");
});

// Polish button.
els.polishBtn.addEventListener("click", async () => {
  const promptText = els.prompt.value.trim();
  if (!promptText) {
    setStatus("Type a prompt first.", "err");
    return;
  }

  els.polishBtn.disabled = true;
  els.copyBtn.disabled = true;
  setStatus("Polishing…", "loading");

  const result = await window.lazyAI.polish({
    modelId: els.model.value,
    promptText,
    context: els.context.value,
    fileName: attachedFile?.name,
    fileText: attachedFile?.text,
  });

  els.polishBtn.disabled = false;

  if (result.ok) {
    els.output.value = result.text;
    els.copyBtn.disabled = false;
    setStatus("Done.", "ok");
  } else {
    setStatus(result.error, "err");
  }
});

// Copy button.
els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.output.value);
  setStatus("Copied to clipboard.", "ok");
});

loadModels();
