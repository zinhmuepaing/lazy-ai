// Lazy AI extension — content script (the in-tab UX).
//
// Adds a floating ✨ button. When clicked (or the toolbar icon is used), it
// reads the text from the focused input/textarea/contenteditable, sends it to
// the desktop app via the background worker, shows the polished result in a
// panel, and can replace the text in place.

(() => {
  if (window.__lazyAiInjected) return;
  window.__lazyAiInjected = true;

  const MODELS = [
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
  ];

  // Remember the last editable element the user focused, so clicking our button
  // (which steals focus) doesn't lose the target.
  let lastEditable = null;
  document.addEventListener(
    "focusin",
    (e) => {
      if (isEditable(e.target)) lastEditable = e.target;
    },
    true
  );

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "TEXTAREA" ||
      (tag === "INPUT" && /^(text|search|url|email|tel|"")$/i.test(el.type || "text")) ||
      el.isContentEditable
    );
  }

  function getText(el) {
    if (!el) return "";
    return el.isContentEditable ? el.innerText : el.value;
  }

  // Robustly write text back into the field so React-controlled inputs (ChatGPT,
  // Claude, etc.) actually register the change.
  function setText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      // execCommand fires the input events frameworks listen for.
      document.execCommand("insertText", false, text);
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ---- UI -----------------------------------------------------------------
  const btn = document.createElement("button");
  btn.id = "lazy-ai-fab";
  btn.title = "Lazy AI — polish the focused text box";
  // Relative URLs in injected CSS resolve against the page's domain, not the
  // extension. chrome.runtime.getURL() gives the correct extension-local URL.
  btn.style.backgroundImage = `url("${chrome.runtime.getURL("icon.png")}")`;
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "lazy-ai-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="la-head">
      <span class="la-title">Lazy<b>AI</b></span>
      <select class="la-model"></select>
      <button class="la-close" title="Close">✕</button>
    </div>
    <div class="la-status"></div>
    <textarea class="la-output" rows="8" placeholder="polished prompt will appear here..."></textarea>
    <div class="la-actions">
      <button class="la-replace">Replace</button>
      <button class="la-copy">Copy</button>
    </div>
  `;
  document.body.appendChild(panel);

  const modelSel = panel.querySelector(".la-model");
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSel.appendChild(opt);
  }

  const statusEl = panel.querySelector(".la-status");
  const outputEl = panel.querySelector(".la-output");

  function setStatus(msg, kind = "") {
    statusEl.textContent = msg;
    statusEl.className = "la-status" + (kind ? " " + kind : "");
  }

  function showPanel() {
    panel.style.display = "block";
  }

  panel.querySelector(".la-close").addEventListener("click", () => {
    panel.style.display = "none";
  });

  panel.querySelector(".la-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(outputEl.value);
    setStatus("Copied.", "ok");
  });

  panel.querySelector(".la-replace").addEventListener("click", () => {
    if (!lastEditable) {
      setStatus("No text field to replace into.", "err");
      return;
    }
    setText(lastEditable, outputEl.value);
    setStatus("Replaced in place.", "ok");
    panel.style.display = "none";
  });

  async function runPolish() {
    const target = lastEditable || (isEditable(document.activeElement) ? document.activeElement : null);
    const text = getText(target).trim();
    if (!text) {
      showPanel();
      setStatus("Click into a text box with some text first.", "err");
      return;
    }
    showPanel();
    setStatus("Polishing…", "loading");
    outputEl.value = "";

    chrome.runtime.sendMessage(
      { type: "polish", text, modelId: modelSel.value },
      (resp) => {
        if (chrome.runtime.lastError) {
          setStatus(chrome.runtime.lastError.message, "err");
          return;
        }
        if (resp?.ok) {
          outputEl.value = resp.text;
          setStatus("Done. Review, then Replace.", "ok");
        } else {
          setStatus(resp?.error || "Something went wrong.", "err");
        }
      }
    );
  }

  btn.addEventListener("click", runPolish);

  // Toolbar icon → polish the focused field.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "polish-focused") runPolish();
  });
})();
