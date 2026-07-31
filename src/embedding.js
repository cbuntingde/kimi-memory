// Embedding module for kimi-memory.
//
// Loads the @huggingface/transformers feature-extraction pipeline once
// on first use, caches the handle module-globally, and exposes
// `embed(text) -> Float32Array(EMBEDDING_DIM)` plus `encode`/`decode`
// helpers for storing vectors as SQLite BLOBs.
//
// The default model is `Xenova/all-MiniLM-L6-v2` (384-dim, ~25 MB on
// disk). The plugin is local-first: no API key, no remote calls at
// runtime once the model is cached.
//
// Hard-fail behavior: any failure inside `embedText()` is caught and
// the function returns `null`. Callers must treat `null` as "embedding
// unavailable" and continue with whatever path they have. A one-line
// stderr message is emitted the first time the model fails to load so
// operators can see it, but the plugin does not crash.

export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

let pipelinePromise = null;
let pipelineLoaded = false;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Node-side: disable browser cache, allow remote model download from HF Hub.
      env.allowLocalModels = false;
      env.useBrowserCache = false;
      const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true });
      pipelineLoaded = true;
      return pipe;
    })();
  }
  return pipelinePromise;
}

export function isEmbeddingAvailable() {
  return pipelineLoaded;
}

// Internal: returns the raw Float32Array (length EMBEDDING_DIM) or
// null on failure. No logging; logging happens in the wrapper.
async function embedRaw(text) {
  if (!text || !text.trim()) return null;
  const pipe = await getPipeline();
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}

let warnedOnce = false;
function warnOnce(msg) {
  if (warnedOnce) return;
  warnedOnce = true;
  try {
    process.stderr.write(`[kimi-memory] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

export async function embedText(text) {
  // Canonical opt-out. When KIMI_MEMORY_EMBEDDINGS=off we never touch
  // the model; embedText is a no-op and returns null. Set by tests via
  // _helpers.js; the CLI and MCP server leave it unset.
  if (process.env.KIMI_MEMORY_EMBEDDINGS === 'off') return null;
  try {
    const v = await embedRaw(text);
    if (!v) return null;
    if (v.length !== EMBEDDING_DIM) {
      warnOnce(`embedding dim mismatch: got ${v.length}, expected ${EMBEDDING_DIM}`);
      return null;
    }
    return v;
  } catch (e) {
    warnOnce(`embeddings unavailable: ${e && e.message ? e.message : e}`);
    return null;
  }
}

// Synchronous availability probe. Useful for hooks / CLI / tests that
// want to skip embedding work without paying the model-load latency.
export function embeddingsAvailable() {
  return pipelineLoaded;
}

// BLOB <-> Float32Array helpers. We store the raw little-endian
// float32 bytes; SQLite BLOB preserves them byte-for-byte.
export function encodeVector(vec) {
  if (!vec) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(buf) {
  if (!buf) return null;
  // buf may be a Uint8Array (from node:sqlite) or a Buffer. Treat the
  // first EMBEDDING_DIM*4 bytes as a Float32Array.
  const u8 =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return new Float32Array(ab);
}

// Pure-JS dot product. The MiniLM pipeline returns L2-normalized
// vectors, so the dot product equals cosine similarity in [-1, 1].
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
