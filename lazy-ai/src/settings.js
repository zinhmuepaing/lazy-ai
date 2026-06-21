// Settings window UI logic. Talks to the main process only through the safe
// window.lazyAI bridge (getSettings / saveSettings). API key values are never
// received from main — we only learn whether each key is "set".

const els = {
  hotkey: document.getElementById("hotkey"),
  defaultModel: document.getElementById("defaultModel"),
  screenTeacherModel: document.getElementById("screenTeacherModel"),
  keyAnthropic: document.getElementById("key-anthropic"),
  keyGemini: document.getElementById("key-gemini"),
  keyOpenai: document.getElementById("key-openai"),
  saveBtn: document.getElementById("saveBtn"),
  activeHotkey: document.getElementById("activeHotkey"),
  status: document.getElementById("status"),
  statusAnthropic: document.getElementById("status-anthropic"),
  statusGemini: document.getElementById("status-gemini"),
  statusOpenai: document.getElementById("status-openai"),
};

// Curated, reliable accelerators (Electron maps CommandOrControl → Ctrl on
// Windows). A preset list avoids the pitfalls of free-form accelerator entry.
const HOTKEYS = [
  { value: "CommandOrControl+Shift+Space", label: "Ctrl + Shift + Space" },
  { value: "CommandOrControl+Alt+Space", label: "Ctrl + Alt + Space" },
  { value: "CommandOrControl+Alt+P", label: "Ctrl + Alt + P" },
  { value: "CommandOrControl+Shift+P", label: "Ctrl + Shift + P" },
  { value: "CommandOrControl+Alt+L", label: "Ctrl + Alt + L" },
];

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function showActiveHotkey(pretty) {
  els.activeHotkey.textContent = pretty
    ? `Working now: press ${pretty} anywhere to summon Lizzie.`
    : "No hotkey active — open from the tray icon instead.";
}

function fillKeyStatus(keyStatus) {
  const map = {
    anthropic: els.statusAnthropic,
    gemini: els.statusGemini,
    openai: els.statusOpenai,
  };
  for (const [provider, el] of Object.entries(map)) {
    const set = keyStatus[provider];
    el.textContent = set ? "● set" : "○ not set";
    el.classList.toggle("set", set);
  }
}

async function load() {
  const s = await window.lazyAI.getSettings();

  // Hotkey dropdown — include the stored value even if it's not a preset.
  const options = [...HOTKEYS];
  if (s.hotkey && !options.some((o) => o.value === s.hotkey)) {
    options.unshift({ value: s.hotkey, label: s.hotkey.replace("CommandOrControl", "Ctrl") + " (current)" });
  }
  els.hotkey.innerHTML = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === s.hotkey) opt.selected = true;
    els.hotkey.appendChild(opt);
  }

  // Default-model dropdown — mirrors the polish model list.
  els.defaultModel.innerHTML = "";
  const selectedModel = s.defaultModel || s.engineDefaultModel;
  for (const [id, info] of Object.entries(s.models)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    if (id === selectedModel) opt.selected = true;
    els.defaultModel.appendChild(opt);
  }

  // Screen Teacher (vision) model dropdown.
  els.screenTeacherModel.innerHTML = "";
  const selectedScreenModel = s.screenTeacherModel || s.engineScreenTeacherModel;
  for (const [id, info] of Object.entries(s.screenTeacherModels || {})) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    if (id === selectedScreenModel) opt.selected = true;
    els.screenTeacherModel.appendChild(opt);
  }

  fillKeyStatus(s.keyStatus);
  showActiveHotkey(s.prettyActiveHotkey);
}

els.saveBtn.addEventListener("click", async () => {
  els.saveBtn.disabled = true;
  setStatus("Saving…", "loading");

  // Only send a key if the user typed one; blank means "keep current".
  const keys = {};
  if (els.keyAnthropic.value.trim()) keys.anthropic = els.keyAnthropic.value.trim();
  if (els.keyGemini.value.trim()) keys.gemini = els.keyGemini.value.trim();
  if (els.keyOpenai.value.trim()) keys.openai = els.keyOpenai.value.trim();

  const result = await window.lazyAI.saveSettings({
    hotkey: els.hotkey.value,
    defaultModel: els.defaultModel.value,
    screenTeacherModel: els.screenTeacherModel.value,
    keys,
  });

  els.saveBtn.disabled = false;

  // Clear the inputs so the typed secrets don't linger on screen.
  els.keyAnthropic.value = "";
  els.keyGemini.value = "";
  els.keyOpenai.value = "";
  fillKeyStatus(result.keyStatus);
  showActiveHotkey(result.prettyActiveHotkey);

  if (!result.hotkeyRegistered) {
    setStatus("Saved, but no hotkey could be registered. Open from the tray icon instead.", "err");
  } else if (!result.gotRequestedHotkey) {
    // Their chosen key was taken by another app, so we kept a working fallback.
    setStatus(
      `Saved — but ${result.prettyRequestedHotkey} is already used by another app, so Lizzie is still on ${result.prettyActiveHotkey}. Pick a different key if you want to change it.`,
      "err"
    );
  } else {
    setStatus(`Saved. Press ${result.prettyActiveHotkey} anywhere to summon Lizzie.`, "ok");
  }
});

load();
