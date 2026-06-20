// Lazy AI extension — content script (the in-tab UX).
//
// Adds a floating Lazy AI button. When clicked (or the toolbar icon is used), it
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
      <span class="la-brand">
        <img class="la-logo" alt="" />
        <span class="la-wordmark">Lazy AI</span>
      </span>
      <div class="la-model-dd">
        <button type="button" class="la-model-trigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="la-model-ic"></span>
          <span class="la-model-name"></span>
          <svg class="la-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="la-model-menu" role="listbox" hidden></div>
      </div>
      <button class="la-close" title="Close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="la-status"></div>
    <textarea class="la-output" rows="8" placeholder="polished prompt will appear here..."></textarea>
    <div class="la-actions">
      <div class="la-actions-left">
        <button class="la-replace" title="Use — replace the text in place">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
          Use
        </button>
        <button class="la-copy" title="Copy" aria-label="Copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        </button>
      </div>
      <button class="la-repeat" title="Polish again" aria-label="Polish again">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      </button>
    </div>
  `;
  // Brand logo (extension-local asset; resolves to a chrome-extension:// URL).
  const logoEl = panel.querySelector(".la-logo");
  if (logoEl) logoEl.src = chrome.runtime.getURL("icon.png");
  document.body.appendChild(panel);

  // ---- Model picker (custom dropdown with provider brand icons) ----------
  // Native <option> can't render an icon, so build a small dropdown.
  let selectedModelId = MODELS[0].id;
  let geminiGradSeq = 0;
  function providerIconSVG(key) {
    const k = (key || "").toLowerCase();
    if (k.includes("gemini")) {
      const id = "la-gem-grad-" + geminiGradSeq++;
      return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="${id}" x1="0%" x2="68.73%" y1="100%" y2="30.395%"><stop offset="0%" stop-color="#1C7DFF"/><stop offset="52.021%" stop-color="#1C69FF"/><stop offset="100%" stop-color="#F0DCD6"/></linearGradient></defs><path d="M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12" fill="url(#${id})" fill-rule="nonzero"/></svg>`;
    }
    if (k.includes("gpt") || k.includes("openai")) {
      return `<svg viewBox="0 0 256 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="#1d1d1f"><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="#1d1d1f" fill-rule="evenodd"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>`;
  }
  const CHECK_SVG =
    '<svg class="la-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const modelDD = panel.querySelector(".la-model-dd");
  const modelTrigger = panel.querySelector(".la-model-trigger");
  const modelTriggerIc = panel.querySelector(".la-model-ic");
  const modelTriggerName = panel.querySelector(".la-model-name");
  const modelMenu = panel.querySelector(".la-model-menu");

  function setModelMenuOpen(open) {
    if (modelMenu) modelMenu.hidden = !open;
    modelTrigger?.setAttribute("aria-expanded", String(open));
  }
  function selectModel(m) {
    selectedModelId = m.id;
    if (modelTriggerIc) modelTriggerIc.innerHTML = providerIconSVG(m.id + " " + m.label);
    if (modelTriggerName) modelTriggerName.textContent = m.label;
    for (const item of modelMenu ? modelMenu.querySelectorAll(".la-model-item") : []) {
      item.classList.toggle("selected", item.dataset.id === m.id);
    }
  }
  for (const m of MODELS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "la-model-item";
    item.dataset.id = m.id;
    item.setAttribute("role", "option");
    item.innerHTML =
      `<span class="la-menu-ic">${providerIconSVG(m.id + " " + m.label)}</span>` +
      `<span class="la-model-label">${m.label}</span>` +
      CHECK_SVG;
    item.addEventListener("click", () => {
      selectModel(m);
      setModelMenuOpen(false);
    });
    modelMenu.appendChild(item);
  }
  selectModel(MODELS[0]);
  modelTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    setModelMenuOpen(modelMenu ? modelMenu.hidden : false);
  });
  document.addEventListener("click", (e) => {
    if (modelDD && !modelDD.contains(e.target)) setModelMenuOpen(false);
  });

  const statusEl = panel.querySelector(".la-status");
  const outputEl = panel.querySelector(".la-output");

  function setStatus(msg, kind = "") {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "la-status" + (kind ? " " + kind : "");
  }

  function showPanel() {
    panel.style.display = "block";
  }

  panel.querySelector(".la-close")?.addEventListener("click", () => {
    panel.style.display = "none";
  });

  panel.querySelector(".la-copy")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(outputEl.value);
    setStatus("Copied.", "ok");
  });

  panel.querySelector(".la-replace")?.addEventListener("click", () => {
    if (!lastEditable) {
      setStatus("No text field to replace into.", "err");
      return;
    }
    setText(lastEditable, outputEl.value);
    setStatus("Replaced in place.", "ok");
    panel.style.display = "none";
  });

  // Repeat — polish the source field again for a fresh result.
  panel.querySelector(".la-repeat")?.addEventListener("click", () => runPolish());

  async function runPolish() {
    const target = lastEditable || (isEditable(document.activeElement) ? document.activeElement : null);
    const text = getText(target).trim();
    if (!text) {
      showPanel();
      setStatus("Click into a text box with some text first.", "err");
      return;
    }
    showPanel();

    // If the extension was reloaded/updated, THIS tab still runs the old content
    // script whose link to the extension is dead — `chrome.runtime.id` goes
    // undefined and any sendMessage throws "Extension context invalidated".
    // Detect it and tell the user to refresh instead of crashing.
    if (!chrome.runtime?.id) {
      setStatus("Lazy AI was updated — refresh this page (Ctrl+R) to reconnect.", "err");
      return;
    }

    setStatus("Polishing…", "loading");
    if (outputEl) outputEl.value = "";

    try {
      chrome.runtime.sendMessage(
        { type: "polish", text, modelId: selectedModelId },
        (resp) => {
          if (chrome.runtime.lastError) {
            setStatus(chrome.runtime.lastError.message, "err");
            return;
          }
          if (resp?.ok) {
            if (outputEl) outputEl.value = resp.text;
            setStatus("Done. Review, then Use.", "ok");
          } else {
            setStatus(resp?.error || "Something went wrong.", "err");
          }
        }
      );
    } catch (err) {
      setStatus("Lazy AI was updated — refresh this page (Ctrl+R) to reconnect.", "err");
    }
  }

  btn.addEventListener("click", runPolish);

  // Toolbar icon → polish the focused field.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "polish-focused") runPolish();
  });
})();
