// Lizzie — local HTTP server.
//
// The browser extension's background service worker calls this at
// http://localhost:8788/polish. Same request/response contract as the future
// Cloudflare Worker, so deploying later means only swapping the URL.
//
// Uses Node's built-in http (no Express dependency).

const http = require("node:http");
const { polish } = require("./polish-engine");

const PORT = 8788;

// Permissive CORS so the extension (and local tools) can call us. This server
// only ever binds to localhost, so it isn't reachable from the network.
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) reject(new Error("Body too large")); // 5MB guard
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function startLocalServer() {
  const server = http.createServer(async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/polish") {
      try {
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : {};
        const result = await polish(payload);
        res.writeHead(result.ok ? 200 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "lazy-ai" }));
      return;
    }

    // Friendly landing page for a human who types the URL into a browser —
    // otherwise the bare "/" hits the 404 below and looks broken.
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Lizzie</title>` +
          `<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0f1115;color:#e6e8ec;padding:40px">` +
          `<h1 style="margin:0">Lazy<span style="color:#6d7cff">AI</span> server is running ✅</h1>` +
          `<p style="color:#8b93a1">This is the local engine on <code>localhost:8788</code>. ` +
          `It answers <code>POST /polish</code> and <code>GET /health</code> — nothing to see here in a browser. ` +
          `The browser extension talks to it automatically.</p></body>`
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });

  server.on("error", (err) => {
    console.error(`[lazy-ai] Local server error: ${err.message}`);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[lazy-ai] Local server listening on http://localhost:${PORT}`);
  });

  return server;
}

module.exports = { startLocalServer, PORT };
