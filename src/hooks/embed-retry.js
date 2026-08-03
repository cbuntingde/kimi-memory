// Failed-embedding retry pass. The SessionStart hook runs this after
// the decay pass: a row whose `embedding` is NULL but whose
// `last_embed_error` is non-NULL is a candidate for retry, gated on
// (a) the row being older than 24h (so we don't immediately thrash
// on a freshly-failed embed) and (b) at most 5 rows per SessionStart
// (so the hook stays fast).
//
// On success the row's embedding columns flip to populated and
// `last_embed_error` is cleared. On another failure the row is left
// untouched so the next SessionStart (24h later) gets another shot.
//
// Called from src/hooks/run.js `handleSessionStart`. Pure, best-effort:
// any error is swallowed by the caller so the hook never throws.

import {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  embedText,
  encodeVector,
  lastEmbeddingError,
} from '../embedding.js';
import { nowIso } from '../util.js';

// Tunables. Both are deliberately small — this is a hook, not a job.
const RETRY_MIN_AGE_HOURS = 24;
const RETRY_MAX_ROWS = 5;

export async function retryFailedEmbeddings(db, projectKey) {
  if (!db || !projectKey) return { scanned: 0, retried: 0, recovered: 0 };

  // Only consider rows whose last failure is older than the retry
  // age. This stops a freshly-failed embed from being retried 50
  // times in a row before the user even notices. The actual
  // embedding call below is gated by `embedText`'s own
  // KIMI_MEMORY_EMBEDDINGS=off check, so this module stays
  // declarative and test-stubbable.
  const rows = db
    .prepare(
      `
      SELECT id, title, content, last_embed_error, updated_at
      FROM memories
      WHERE project_key = ?
        AND embedding IS NULL
        AND last_embed_error IS NOT NULL
        AND datetime(updated_at) < datetime('now', ?)
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    )
    .all(projectKey, `-${RETRY_MIN_AGE_HOURS} hours`, RETRY_MAX_ROWS);

  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    const text = `${row.title || ''}\n${row.content || ''}`.trim().slice(0, 4000);
    if (!text) continue;
    try {
      const vec = await embedText(text);
      if (vec && vec.length === EMBEDDING_DIM) {
        db.prepare(
          `UPDATE memories
           SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?,
               last_embed_error=NULL
           WHERE id=?`,
        ).run(encodeVector(vec), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), row.id);
        recovered += 1;
      } else {
        // Same shape as saveMemory's failure path: record the most
        // specific reason we have. The 24h gate means we only see
        // this every-so-often per row.
        const reason =
          lastEmbeddingError() ||
          (process.env.KIMI_MEMORY_EMBEDDINGS === 'off'
            ? 'embeddings disabled (KIMI_MEMORY_EMBEDDINGS=off)'
            : 'embedding model unavailable');
        db.prepare(
          `UPDATE memories
           SET last_embed_error=?, embedded_at=?
           WHERE id=?`,
        ).run(reason, nowIso(), row.id);
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, recovered, failed };
}
