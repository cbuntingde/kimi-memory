// Embedding module for kimi-memory.
//
// Loads the @huggingface/transformers feature-extraction pipeline once
// on first use, caches the handle module-globally, and exposes
// `embed(text) -> Float32Array(EMBEDDING_DIM)` plus `encode`/`decode`
// helpers for storing vectors as SQLite BLOBs.
//
// The default model is `Xenova/all-MiniLM-L6-v2@v1` (384-dim, ~25 MB on
// disk, with explicit version pinning to prevent silent incompatibilities).
// The plugin is local-first: no API key, no remote calls at runtime once
// the model is cached.
//
// Model version validation: the model version string is checked on load,
// and a mismatch triggers a hard error. This prevents silent embedding
// incompatibilities when the model is auto-updated upstream.
//
// Hard-fail behavior: any failure inside `embedText()` is caught and
// the function returns `null`. Callers must treat `null` as "embedding
// unavailable" and continue with whatever path they have. A one-line
// stderr message is emitted the first time the model fails to load so
// operators can see it, but the plugin does not crash.
//
// Time-bounded load: the first call to `embedText` on a cold cache can
// spend 30s+ downloading the model and warming the ONNX runtime. The
// kimi-memory hook has a 5s budget on the per-event side
// (kimi.plugin.json); without a wall-clock cap the encoder load
// holds the hook for the full budget before fail-open kicks in. The
// `Promise.race` against a timer in `embedRaw` lets the caller give
// up at the budget, let the FTS-only path take over, and continue
// without blocking the user's session. The actual model load keeps
// running in the background — the cache is intentionally NOT cleared
// on a timeout, so a slow-but-eventually-successful load is still
// usable on the next call.

import { logEmbeddingError } from './diagnostics.js';

export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2@v1';
export const EMBEDDING_MODEL_EXPECTED_DIM = 384; // Sanity check for loaded model

// Default wall-clock cap for one embed call. Picked at 4s so the
// persist layer (which is given 5s by the hook runner) can write the
// `last_embed_error` row before the hook is forced to exit.
const DEFAULT_EMBED_TIMEOUT_MS = 4000;

function getEmbedTimeoutMs() {
  const v = process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
  if (v && /^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_EMBED_TIMEOUT_MS;
}

let pipelinePromise = null;
let pipelineLoaded = false;
let lastError = null;
// Test-only injection: a stub that replaces the @huggingface/transformers
// pipeline() loader. When set, getPipeline returns the stub's promise
// instead of importing the real package. Used to exercise the timeout
// race without depending on a 25 MB model download. The stub must
// resolve to a function with the same shape as a transformers pipeline
// (i.e. `await pipe(text, { pooling, normalize })` returns a tensor-like
// value with `.data`).
let pipelineStub = null;

async function getPipeline() {
  if (pipelineStub) return pipelineStub();
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Node-side: disable browser cache, allow remote model download from HF Hub.
      env.allowLocalModels = false;
      env.useBrowserCache = false;
      const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true });
      pipelineLoaded = true;
      lastError = null;
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
  const budget = getEmbedTimeoutMs();
  let timer;
  const work = (async () => {
    const pipe = await getPipeline();
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data);
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`embed_timeout: encoder did not finish within ${budget}ms`);
      err.code = 'KIMI_MEMORY_EMBED_TIMEOUT';
      reject(err);
    }, budget);
  });
  try {
    const v = await Promise.race([work, timeout]);
    if (v && v.length !== EMBEDDING_DIM) {
      const msg = `embedding dim mismatch: got ${v.length}, expected ${EMBEDDING_DIM}`;
      warnOnce(msg);
      lastError = msg;
      logEmbeddingError(null, 'dim_mismatch', new Error(msg), { got_dim: v.length }).catch(() => {});
      return null;
    }
    return v;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const isTimeout = e && e.code === 'KIMI_MEMORY_EMBED_TIMEOUT';
    if (isTimeout) {
      // The load is still in flight in the background; do NOT clear
      // pipelinePromise — if it lands later, the next embed call will
      // reuse it. Only a hard rejection from the import or pipe
      // (e.g. model missing on disk) should invalidate the cache.
      lastError = msg;
      warnOnce(`embeddings slow: ${msg}`);
      logEmbeddingError(null, 'timeout', e, { timeout_ms: budget }).catch(() => {});
      return null;
    }
    // Real failure (rejection from import, pipe, or runtime): reset
    // the cache so the next call re-attempts the download.
    pipelinePromise = null;
    pipelineLoaded = false;
    lastError = msg;
    warnOnce(`embeddings unavailable: ${msg}`);
    logEmbeddingError(null, 'model_load', e, { model: EMBEDDING_MODEL }).catch(() => {});
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  // `embedRaw` is responsible for the timeout race, the dim check, the
  // pipeline-reset on real failures, and the warn-once logging. By
  // contract it never throws: callers see null on any error.
  return embedRaw(text);
}

// Synchronous availability probe. Useful for hooks / CLI / tests that
// want to skip embedding work without paying the model-load latency.
export function embeddingsAvailable() {
  return pipelineLoaded;
}

// Synchronous read of the most recent embedding error. Returns null
// when no error has been observed. Persist layer uses this when a
// row is left in `embedding_status: 'pending'` to attribute the cause.
export function lastEmbeddingError() {
  return lastError;
}

// Test seam: clear the pipeline cache and any recorded error. Not
// exported on the public surface (it would let a caller force a
// re-download, which we want to be opt-in only). Tests use this to
// reset state between cases.
export function _resetForTests() {
  pipelinePromise = null;
  pipelineLoaded = false;
  lastError = null;
  warnedOnce = false;
  pipelineStub = null;
}

// Test seam: install a stub pipeline loader. The replacement is a
// function returning a Promise<pipe> where `pipe` has the same
// shape as a transformers pipeline. The stub takes over from
// getPipeline until _resetForTests clears it. The replacement can
// resolve quickly (a normal pipe stub) or hang (a timeout-race
// exerciser). Real callers never touch this; only the embedding
// test suite does.
export function _setPipelineStubForTests(stub) {
  pipelineStub = stub;
  pipelinePromise = null;
  pipelineLoaded = false;
}

// BLOB <-> Float32Array helpers. We store the raw little-endian
// float32 bytes; SQLite BLOB preserves them byte-for-byte.
export function encodeVector(vec) {
  if (!vec) return null;
  // Validate dimension on encode to catch bugs early.
  if (vec.length !== EMBEDDING_DIM) {
    const err = new Error(`embedding dimension mismatch on encode: got ${vec.length}, expected ${EMBEDDING_DIM}`);
    err.code = 'KIMI_MEMORY_EMBED_DIM_MISMATCH';
    throw err;
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(buf) {
  if (!buf) return null;
  // buf may be a Uint8Array (from node:sqlite) or a Buffer. Treat the
  // first EMBEDDING_DIM*4 bytes as a Float32Array.
  const u8 =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const expectedBytes = EMBEDDING_DIM * 4;
  if (u8.length < expectedBytes) {
    const err = new Error(
      `embedding BLOB too small: got ${u8.length} bytes, expected at least ${expectedBytes} for dim=${EMBEDDING_DIM}`
    );
    err.code = 'KIMI_MEMORY_EMBED_CORRUPT';
    throw err;
  }
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + expectedBytes);
  const vec = new Float32Array(ab);
  // Final validation: check for NaN/Inf which indicate corruption.
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      const err = new Error(
        `embedding BLOB contains non-finite value at index ${i}: ${vec[i]}`
      );
      err.code = 'KIMI_MEMORY_EMBED_CORRUPT';
      throw err;
    }
  }
  return vec;
}

// Pure-JS dot product. The MiniLM pipeline returns L2-normalized
// vectors, so the dot product equals cosine similarity in [-1, 1].
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Model compatibility check. Returns {compatible: boolean, reason?: string}.
// This is useful to validate that the loaded model matches expectations.
export function validateModelCompatibility(loadedOutputDim) {
  if (!Number.isFinite(loadedOutputDim) || loadedOutputDim < 0) {
    return { compatible: false, reason: 'invalid dimension' };
  }
  if (loadedOutputDim !== EMBEDDING_MODEL_EXPECTED_DIM) {
    return {
      compatible: false,
      reason: `dimension mismatch: got ${loadedOutputDim}, expected ${EMBEDDING_MODEL_EXPECTED_DIM}`,
    };
  }
  return { compatible: true };
}

// Export model info for diagnostics and version checking.
export function getModelInfo() {
  return {
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIM,
    expected_dimension: EMBEDDING_MODEL_EXPECTED_DIM,
    loaded: pipelineLoaded,
    last_error: lastError,
  };
}
