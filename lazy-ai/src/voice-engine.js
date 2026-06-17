// Lazy AI — local speech-to-text (Stage 4.2).
//
// Runs OpenAI Whisper locally via Transformers.js (pure JS + prebuilt ONNX
// runtime — no compiler, no ffmpeg). The model (~140 MB, English) downloads
// once on first use and is cached on disk; nothing audio-related leaves the
// machine. Transformers.js is ESM-only, so we dynamic-import it from this
// CommonJS module and lazy-load the pipeline so app startup isn't blocked.

const MODEL = "Xenova/whisper-base.en"; // English, good accuracy/speed on CPU

let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("automatic-speech-recognition", MODEL);
    })();
    // If loading fails (e.g. offline on first run), let the next call retry.
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
