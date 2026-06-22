// Lizzie — one-time Whisper model bundler (Phase 1A).
//
// Downloads the Xenova/whisper-tiny.en ONNX + tokenizer/config files into
//   lazy-ai/assets/models/Xenova/whisper-tiny.en/
// laid out exactly the way Transformers.js reads a *local* model
// (env.localModelPath + model_id). Once this has run, voice-engine.js loads the
// model from disk with env.allowRemoteModels = false — it NEVER fetches from
// Hugging Face at runtime, so the packaged app needs no download on first use.
//
// Run once:  npm run setup:models   (from the lazy-ai/ folder)
// Re-running is cheap — already-downloaded files are skipped.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL_ID = "Xenova/whisper-tiny.en";
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const OUT_DIR = resolve(__dirname, "..", "assets", "models", MODEL_ID);

// REQUIRED files — the script fails loudly if any of these can't be fetched,
// because the runtime pipeline can't load without them. The two ONNX files must
// match the `dtype` configured in voice-engine.js:
//   encoder_model: "fp32" -> onnx/encoder_model.onnx
//   decoder_model_merged: "q8" -> onnx/decoder_model_merged_quantized.onnx
const REQUIRED = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

// OPTIONAL files — present in most Xenova repos and harmless to include, but a
// 404 just means this particular model doesn't ship them, so we skip quietly.
const OPTIONAL = [
  "vocab.json",
  "merges.txt",
  "normalizer.json",
  "special_tokens_map.json",
  "added_tokens.json",
];

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function fileSize(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : -1;
  } catch {
    return -1;
  }
}

async function download(file, required) {
  const dest = join(OUT_DIR, file);
  const have = await fileSize(dest);
  if (have > 0) {
    console.log(`  • ${file} — already present (${fmtBytes(have)}), skipping`);
    return true;
  }

  const url = `${BASE}/${file}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    if (required) throw new Error(`Network error downloading required ${file}: ${err.message}`);
    console.log(`  • ${file} — network error (${err.message}), skipping (optional)`);
    return false;
  }

  if (!res.ok) {
    if (required) throw new Error(`Failed to download required ${file}: HTTP ${res.status} ${res.statusText}`);
    console.log(`  • ${file} — not in repo (HTTP ${res.status}), skipping (optional)`);
    return false;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  ✓ ${file} — ${fmtBytes(buf.length)}`);
  return true;
}

async function main() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is unavailable — please run this with Node 18+ (Electron 33 ships Node 20).");
  }

  console.log(`Bundling ${MODEL_ID} for offline use`);
  console.log(`  -> ${OUT_DIR}\n`);
  await mkdir(OUT_DIR, { recursive: true });

  for (const f of REQUIRED) await download(f, true);
  for (const f of OPTIONAL) await download(f, false);

  console.log(`\nDone. Whisper '${MODEL_ID}' is bundled locally — the app will not download it at runtime.`);
}

main().catch((err) => {
  console.error(`\n[setup:models] ${err.message}`);
  console.error("Fix the error above and re-run `npm run setup:models`.");
  process.exit(1);
});
