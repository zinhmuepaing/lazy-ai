// Lazy AI — settings store (main process, Stage 3).
//
// Persists user settings to a JSON file in Electron's userData dir (no extra
// dependency). API keys are encrypted at rest with the OS keychain via
// safeStorage (DPAPI on Windows) and are NEVER returned to the renderer — only
// a "set / not set" status is. Stored keys are pushed into process.env so the
// polish engine (which reads process.env at call time) picks them up with no
// changes, taking precedence over whatever .env provided.

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

// provider id (used in settings/UI) → the env var the engine reads.
const KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

const DEFAULTS = {
  hotkey: "CommandOrControl+Shift+Space",
  defaultModel: null, // null → fall back to the engine's DEFAULT_MODEL
  screenTeacherModel: null, // null → fall back to the engine's DEFAULT_SCREEN_TEACHER_MODEL
  keys: {}, // provider → encrypted blob string ("enc:…" or "raw:…")
};

function readRaw() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeRaw(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Encrypt with the OS keychain when available; otherwise fall back to a base64
// obfuscation that's at least not plaintext-greppable. The prefix records which.
function encryptKey(plain) {
  if (!plain) return "";
  if (safeStorage.isEncryptionAvailable()) {
    return "enc:" + safeStorage.encryptString(plain).toString("base64");
  }
  return "raw:" + Buffer.from(plain, "utf8").toString("base64");
}

function decryptKey(stored) {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    }
    if (stored.startsWith("raw:")) {
      return Buffer.from(stored.slice(4), "base64").toString("utf8");
    }
  } catch {
    /* corrupt/unreadable blob — treat as unset */
  }
  return "";
}

// Push any stored keys into process.env. Only overrides when we actually have a
// value, so a missing stored key leaves the .env value intact.
function injectKeysIntoEnv() {
  const { keys } = readRaw();
  for (const [provider, envVar] of Object.entries(KEY_ENV)) {
    const value = decryptKey(keys?.[provider]);
    if (value) process.env[envVar] = value;
  }
}

// Renderer-safe view: hotkey, default model, and booleans for whether each key
// is set. Never includes key values.
function getPublicSettings() {
  const s = readRaw();
  const keyStatus = {};
  for (const [provider, envVar] of Object.entries(KEY_ENV)) {
    // "set" means a key is effectively available — either stored in-app or
    // provided via .env (process.env) — so an existing .env key isn't shown
    // as missing.
    keyStatus[provider] = Boolean(s.keys?.[provider]) || Boolean(process.env[envVar]);
  }
  return { hotkey: s.hotkey, defaultModel: s.defaultModel, screenTeacherModel: s.screenTeacherModel, keyStatus };
}

// Persist a settings update. `keys` values that are empty/absent leave the
// existing stored key unchanged; a value of null explicitly clears it.
function save({ hotkey, defaultModel, screenTeacherModel, keys } = {}) {
  const s = readRaw();
  if (typeof hotkey === "string" && hotkey.trim()) s.hotkey = hotkey.trim();
  if (typeof defaultModel === "string") s.defaultModel = defaultModel || null;
  if (typeof screenTeacherModel === "string") s.screenTeacherModel = screenTeacherModel || null;

  s.keys = s.keys || {};
  if (keys) {
    for (const provider of Object.keys(KEY_ENV)) {
      const value = keys[provider];
      if (value === null) delete s.keys[provider]; // explicit clear
      else if (typeof value === "string" && value.trim()) {
        s.keys[provider] = encryptKey(value.trim());
      }
      // empty/undefined → leave existing key untouched
    }
  }

  writeRaw(s);
  injectKeysIntoEnv();
  return getPublicSettings();
}

module.exports = { injectKeysIntoEnv, getPublicSettings, save, SETTINGS_FILE };
