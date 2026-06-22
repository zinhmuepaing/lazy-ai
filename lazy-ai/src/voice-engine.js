// Lizzie — local speech-to-text (Stage 4.2; offline-bundled in Phase 1A).
//
// Runs OpenAI Whisper locally via Transformers.js (pure JS + prebuilt ONNX
// runtime — no compiler, no ffmpeg). The model is BUNDLED with the app under
// assets/models/ (fetched once by `npm run setup:models`) and loaded with
// env.allowRemoteModels = false, so nothing is downloaded at runtime and
// nothing audio-related ever leaves the machine. Transformers.js is ESM-only,
// so we dynamic-import it from this CommonJS module and lazy-load the pipeline
// so app startup isn't blocked.

const path = require("node:path");
const fs = require("node:fs");

const MODEL = "Xenova/whisper-tiny.en"; // English, tiny — small bundle, fast on CPU

// The ONNX variants we ship (see scripts/download-models.mjs). These MUST match
// the files the download script fetched: fp32 encoder + q8 ("_quantized") decoder.
const DTYPE = { encoder_model: "fp32", decoder_model_merged: "q8" };

// Find the bundled assets/models dir. In dev it sits one level up from src/;
// once packaged (Phase 3) it's asarUnpacked under resources/. Prefer whichever
// actually contains the model folder.
function resolveModelsDir() {
  const candidates = [path.join(__dirname, "..", "assets", "models")];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "assets", "models"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "assets", "models"));
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, MODEL))) return dir;
  }
  return candidates[0]; // getTranscriber() throws a clear setup hint if it's missing
}

let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");

      // Lock the library to the bundled model — never reach out to Hugging Face.
      const modelsDir = resolveModelsDir();
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = modelsDir;

      const modelDir = path.join(modelsDir, MODEL);
      if (!fs.existsSync(modelDir)) {
        throw new Error(
          `Whisper model not found at ${modelDir}. Run \`npm run setup:models\` to bundle it offline.`
        );
      }

      return pipeline("automatic-speech-recognition", MODEL, { dtype: DTYPE });
    })();
    // If loading fails, let the next call retry from scratch.
    transcriberPromise.catch(() => {
      transcriberPromise = null;
    });
  }
  return transcriberPromise;
}

// audio: a Float32Array of mono PCM samples at 16 kHz (what the overlay sends
// after resampling). Returns the transcribed text.
async function transcribe(audio) {
  const samples = audio instanceof Float32Array ? audio : Float32Array.from(audio || []);
  if (!samples.length) return "";
  const transcriber = await getTranscriber();
  const output = await transcriber(samples, { chunk_length_s: 30, stride_length_s: 5 });
  return (output?.text || "").trim();
}

module.exports = { transcribe, MODEL };
