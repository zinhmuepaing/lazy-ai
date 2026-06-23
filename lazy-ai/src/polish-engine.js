// Lizzie — shared polishing engine.
//
// This is the single "brain." It's used in two places:
//   1. The Electron IPC handlers (the desktop window / floating popup).
//   2. The local HTTP server at localhost:8788 (which the browser extension calls).
//
// Keys are read from process.env (loaded from .env by main.js). No UI code here.

const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Model registry — maps the UI dropdown id to a provider + the real API model id.
// If a provider returns "model not found", fix the `apiModel` value here.
// ---------------------------------------------------------------------------
const MODELS = {
  "claude-haiku-4.5": { provider: "anthropic", apiModel: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  "gemini-3.1-flash-lite": { provider: "gemini", apiModel: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  "gpt-5.4-nano": { provider: "openai", apiModel: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
};

const DEFAULT_MODEL = "claude-haiku-4.5";

const POLISH_SYSTEM_PROMPT = `you are a prompt-rewriting engine. you take a user's rough, messy prompt and rewrite it into a clean, clear, well-structured prompt that another AI will execute well.

rules:
- fix grammar, spelling, and confusing wording. preserve the user's actual intent exactly — never add requirements they didn't ask for.
- make it token-efficient: cut filler, keep substance. clear and dense beats long.
- structure it sensibly. use short sections or bullets only when they genuinely help the target AI (e.g. task, context, constraints, desired output). don't over-format a simple request.
- if the user provided extra context (style, background, audience, output format), fold it into the prompt naturally.
- if the user attached a reference document, use it as context the target AI should consider — summarize or reference it appropriately rather than dumping it verbatim.
- output ONLY the rewritten prompt. no preamble, no explanation, no "here's your prompt", no surrounding quotes or code fences.`;

function buildUserMessage({ promptText, context, fileName, fileText, fileImage }) {
  let msg = `Rewrite this prompt:\n\n${(promptText || "").trim()}`;
  if (context && context.trim()) {
    msg += `\n\n--- Extra context / desired style ---\n${context.trim()}`;
  }
  if (fileText && fileText.trim()) {
    msg += `\n\n--- Attached reference file: ${fileName || "document"} ---\n${fileText.trim()}`;
  }
  if (fileImage) {
    msg += `\n\n--- Attached reference image: ${fileName || "image"} ---\n(consider the attached image as context for the rewrite)`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Provider calls. Node 18+ has a global fetch.
// ---------------------------------------------------------------------------
async function callAnthropic(apiModel, userMessage, image) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is missing — set it in Settings or .env");

  // Anthropic accepts content as a plain string or, for vision, an array of
  // text + image blocks.
  const content = image
    ? [
        { type: "text", text: userMessage },
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
      ]
    : userMessage;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: 1024,
      system: POLISH_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Take the TEXT block(s) — content[0] can be a "thinking" block on some models.
  return (data.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
}

async function callGemini(apiModel, userMessage, image) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing — set it in Settings or .env");

  const parts = image
    ? [{ text: userMessage }, { inline_data: { mime_type: image.mediaType, data: image.base64 } }]
    : [{ text: userMessage }];

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: POLISH_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

async function callOpenAI(apiModel, userMessage, image) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is missing — set it in Settings or .env");

  // For vision, OpenAI takes the user content as an array of text + image_url
  // (a data: URL) parts.
  const userContent = image
    ? [
        { type: "text", text: userMessage },
        { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
      ]
    : userMessage;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: apiModel,
      messages: [
        { role: "system", content: POLISH_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Unified polish entry point. Returns { ok, text } or { ok:false, error }.
// ---------------------------------------------------------------------------
async function polish(payload) {
  const model = MODELS[payload?.modelId] || MODELS[DEFAULT_MODEL];
  const userMessage = buildUserMessage(payload || {});
  const image = payload?.fileImage; // { base64, mediaType } | undefined (vision)
  try {
    let text;
    if (model.provider === "anthropic") text = await callAnthropic(model.apiModel, userMessage, image);
    else if (model.provider === "gemini") text = await callGemini(model.apiModel, userMessage, image);
    else if (model.provider === "openai") text = await callOpenAI(model.apiModel, userMessage, image);
    else throw new Error(`Unknown provider for model ${payload?.modelId}`);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// File parsing for the optional attachment (desktop app only).
// ---------------------------------------------------------------------------
async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const TEXT_EXTS = [
    ".txt", ".md", ".js", ".ts", ".py", ".json", ".html", ".css",
    ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".swift",
    ".sh", ".yml", ".yaml", ".xml", ".csv",
  ];

  if (TEXT_EXTS.includes(ext)) return fs.readFileSync(filePath, "utf8");
  if (ext === ".pdf") {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text;
  }
  if (ext === ".docx") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

// Image attachments (for vision). Maps extension → MIME media type.
const IMAGE_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

// Read an attachment as either extracted text (docs/code) or a base64 image
// (for vision). Returns { text } or { image: { base64, mediaType } }.
async function extractAttachment(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (mediaType) {
    const base64 = fs.readFileSync(filePath).toString("base64");
    return { image: { base64, mediaType } };
  }
  return { text: await extractTextFromFile(filePath) };
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  polish,
  extractTextFromFile,
  extractAttachment,
  IMAGE_MEDIA_TYPES,
};
