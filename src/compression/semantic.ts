/**
 * Semantic compression using LLMLingua-2
 * Model: microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank
 *
 * Reduces text by identifying and dropping semantically unimportant tokens.
 * Uses @huggingface/transformers (ONNX Runtime) for local inference.
 *
 * Pipeline is loaded lazily on first use and cached in memory.
 * Model files are cached in ~/.lucid/models/ after first download (~700MB).
 *
 * Falls back to original text on any error — safe to call unconditionally.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

// Microsoft's original repo ships only PyTorch weights, so transformers.js
// (ONNX Runtime) cannot load it. ldenoue/* mirrors the same checkpoint with
// pre-built `onnx/model.onnx` (710 MB) and `onnx/model_quantized.onnx` (179 MB),
// matching the dtype lookups used below.
const MODEL_ID = "ldenoue/llmlingua-2-bert-base-multilingual-cased-meetingbank";
const MODELS_DIR = join(homedir(), ".lucid", "models");

// ---------------------------------------------------------------------------
// Types (avoid importing top-level from @huggingface/transformers to keep
// startup fast — pipeline is loaded lazily)
// ---------------------------------------------------------------------------

export interface SemanticCompressionResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  /** Fraction of tokens kept (1.0 = no compression) */
  ratio: number;
  method: "llmlingua2" | "fallback";
}

// ---------------------------------------------------------------------------
// Lazy pipeline singleton
// ---------------------------------------------------------------------------

type TokenClassificationEntry = {
  entity: string;
  score: number;
  index: number;
  word: string;
  start: number;
  end: number;
};

type Pipeline = (
  text: string,
  options?: Record<string, unknown>
) => Promise<TokenClassificationEntry[]>;

let _pipeline: Pipeline | null = null;
let _loadError: Error | null = null;
let _loading = false;

async function getPipeline(): Promise<Pipeline> {
  if (_loadError) throw _loadError;
  if (_pipeline) return _pipeline;
  if (_loading) {
    // Wait for concurrent load
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!_loading) { clearInterval(check); resolve(); }
      }, 100);
    });
    if (_loadError) throw _loadError;
    if (_pipeline) return _pipeline;
  }

  _loading = true;
  try {
    mkdirSync(MODELS_DIR, { recursive: true });

    // Dynamic import keeps startup fast when compression is not used
    const { pipeline, env } = await import("@huggingface/transformers");

    env.cacheDir = MODELS_DIR;
    env.allowRemoteModels = true;

    process.stderr.write(
      `[Lucid] Loading LLMLingua-2 model (first run: downloads ~700MB to ${MODELS_DIR})…\n`
    );

    _pipeline = (await pipeline("token-classification", MODEL_ID, {
      dtype: "q8",        // 8-bit quantization — smaller, faster, minimal quality loss
      device: "cpu",
    })) as unknown as Pipeline;

    process.stderr.write("[Lucid] LLMLingua-2 model ready.\n");
    return _pipeline;
  } catch (e) {
    _loadError = e instanceof Error ? e : new Error(String(e));
    throw _loadError;
  } finally {
    _loading = false;
  }
}

// ---------------------------------------------------------------------------
// Core compression
// ---------------------------------------------------------------------------

/**
 * Compress text using LLMLingua-2 token importance scoring.
 *
 * @param text         Input text to compress
 * @param targetRatio  Target compression ratio (0.3 = keep 30%, 0.5 = keep 50%)
 * @param minLength    Skip compression for texts shorter than this (chars)
 */
export async function compressTextSemantic(
  text: string,
  targetRatio = 0.5,
  minLength = 300
): Promise<SemanticCompressionResult> {
  if (text.length < minLength) {
    return {
      compressed: text,
      originalLength: text.length,
      compressedLength: text.length,
      ratio: 1.0,
      method: "fallback",
    };
  }

  const pipe = await getPipeline();

  // Run token classification — each token gets entity "LABEL_0" (drop) / "LABEL_1" (keep)
  const tokens = await pipe(text, {
    // Disable aggregation to get per-sub-token results with offsets
    aggregation_strategy: "none",
  });

  if (!tokens || tokens.length === 0) {
    return {
      compressed: text,
      originalLength: text.length,
      compressedLength: text.length,
      ratio: 1.0,
      method: "fallback",
    };
  }

  // Determine importance threshold:
  // Sort all "keep" scores descending, keep the top (targetRatio * N) tokens
  const keepScores = tokens
    .filter((t) => t.entity === "LABEL_1" || t.entity === "1")
    .map((t) => t.score)
    .sort((a, b) => b - a);

  // If not enough LABEL_1 tokens, use score-based threshold
  let threshold: number;
  if (keepScores.length > 0) {
    const cutoffIdx = Math.floor(tokens.length * targetRatio);
    // Find the score at the cutoff rank among all tokens sorted by score
    const allScores = tokens.map((t) => ({
      score: t.entity === "LABEL_1" || t.entity === "1" ? t.score : 1 - t.score,
    })).sort((a, b) => b.score - a.score);
    threshold = allScores[Math.min(cutoffIdx, allScores.length - 1)]?.score ?? 0.5;
  } else {
    // Fallback: use raw score threshold
    threshold = 0.5;
  }

  // Mark characters to keep based on token offsets
  const keepChars = new Uint8Array(text.length);

  for (const token of tokens) {
    const isImportant =
      token.entity === "LABEL_1" ||
      token.entity === "1" ||
      (token.entity !== "LABEL_0" && token.entity !== "0" && token.score >= threshold);

    if (isImportant && token.start !== undefined && token.end !== undefined) {
      keepChars.fill(1, token.start, token.end);
    }
  }

  // Always keep structural markers (newlines, sentence boundaries)
  const FORCE_KEEP = new Set(["\n", ".", "!", "?", ","]);
  for (let i = 0; i < text.length; i++) {
    if (FORCE_KEEP.has(text[i]!)) keepChars[i] = 1;
  }

  // Reconstruct compressed text from character mask
  let compressed = "";
  let prevKept = false;
  for (let i = 0; i < text.length; i++) {
    if (keepChars[i]) {
      // Preserve a single space when skipping tokens in mid-sentence
      if (!prevKept && compressed.length > 0 && text[i] !== " " && !FORCE_KEEP.has(text[i - 1] ?? "")) {
        compressed += " ";
      }
      compressed += text[i];
      prevKept = true;
    } else {
      prevKept = false;
    }
  }

  // Clean up artefacts from compression
  compressed = compressed
    .replace(/  +/g, " ")          // multiple spaces → single
    .replace(/\n{3,}/g, "\n\n")    // more than 2 newlines → 2
    .replace(/ ([.,!?])/g, "$1")   // space before punctuation → no space
    .trim();

  const keptCount = keepScores.length;
  const actualRatio = tokens.length > 0 ? keptCount / tokens.length : 1.0;

  return {
    compressed,
    originalLength: text.length,
    compressedLength: compressed.length,
    ratio: actualRatio,
    method: "llmlingua2",
  };
}

// ---------------------------------------------------------------------------
// Safe wrapper — always returns a string, never throws
// ---------------------------------------------------------------------------

export async function tryCompressTextSemantic(
  text: string,
  targetRatio = 0.5,
  minLength = 300
): Promise<string> {
  try {
    const result = await compressTextSemantic(text, targetRatio, minLength);
    return result.compressed;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Availability check — call before bulk compression to fail fast
// ---------------------------------------------------------------------------

export async function isSemanticCompressionAvailable(): Promise<boolean> {
  try {
    await getPipeline();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Warm-up (optional — call at startup to pre-load model)
// ---------------------------------------------------------------------------

export function warmUpSemanticCompression(): void {
  getPipeline().catch(() => { /* silent — model loading is optional */ });
}
