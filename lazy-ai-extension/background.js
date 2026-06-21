// Lizzie extension — background service worker.
//
// The only job: relay polish requests from the content script to the local
// desktop server. The content script can't reach localhost directly (page CORS),
// but the background worker can, thanks to host_permissions in manifest.json.

const LOCAL_SERVER = "http://localhost:8788/polish";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "polish") return;

  fetch(LOCAL_SERVER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: msg.modelId, promptText: msg.text }),
  })
    .then((r) => r.json())
    .then((data) => sendResponse(data))
    .catch((e) =>
      sendResponse({
        ok: false,
        error:
          String(e.message || e) +
          " — is the Lizzie desktop app running? (it hosts localhost:8788)",
      })
    );

  return true; // keep the message channel open for the async response
});

// Clicking the toolbar icon also polishes the focused field.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "polish-focused" });
});
