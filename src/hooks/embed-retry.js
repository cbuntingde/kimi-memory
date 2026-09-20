// Failed-embedding retry pass. The SessionStart hook runs this after
// the decay pass: a row whose `embedding` is NULL but whose
// `last_embed_error` is non-NULL is a candidate for retry, gated on
// (a) the row being older than 24h (so we don't immediately thrash
// on a freshly-failed embed), (b) at most 5 rows per SessionStart
// (so the hook stays fast), and (c) a total wall-clock budget for the
// pass. Without (c) the row cap was the only bound: five sequential
// `embedText` calls, each with its own 4 s cap, is 20 s against
// SessionStart's 9 s dispatcher ceiling.
//
// On success the row's embedding columns flip to populated and
// `last_embed_error` is cleared. On another failure the row is left
// untouched so the next SessionStart (24h later) gets another shot.
//
// Called from src/hooks/handlers/session-start.js `handleSessionStart`.
// Pure, best-effort: any error is swallowed by the caller so the hook
// never throws.

import {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  embedText,
  encodeVector,
  lastEmbeddingError,
} from '../embedding.js';
import { nowIso, safeErrorMessage } from '../util.js';

// Tunables. All are deliberately small — this is a hook, not a job.
const RETRY_MIN_AGE_HOURS = 24;
const RETRY_MAX_ROWS = 5;

// Total wall-clock budget for the pass. The row cap alone was not a
// bound: five sequential `embedText` calls, each with its own 4 s cap
// (src/embedding.js), is 20 s against SessionStart's 9 s dispatcher
// ceiling, so the process gets killed mid-pass and the status line
// never renders.
//
// A fresh attempt is refused once elapsed time reaches this budget, so
// the pass can overrun by at most ONE in-flight attempt — `embedText`
// caps that at 4 s and the attempt is not preemptible. Worst case is
// therefore 2000 + 4000 = 6000 ms, which leaves 3000 ms of the 9000 ms
// SessionStart ceiling for decay/consolidate/auto-GC and the status
// render. Reserving a full attempt's cost per iteration instead (the
// previous shape) made the budget equal to the per-attempt cost, so the
// pass stopped after a single row as soon as any time had elapsed.
const DEFAULT_RETRY_BUDGET_MS = 2000;

export async function retryFailedEmbeddings(
  db,
  projectKey,
  { budgetMs = DEFAULT_RETRY_BUDGET_MS } = {},
) {
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
  let attempted = 0;
  let budgetExhausted = false;
  const startedAt = Date.now();
  for (const row of rows) {
    // Refuse to START an attempt once the budget has elapsed. The
    // attempt already in flight is bounded separately by `embedText`'s
    // own timeout; the pass cannot preempt it, which is why the budget
    // is checked before starting rather than as a hard deadline.
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }
    const text = `${row.title || ''}\n${row.content || ''}`.trim().slice(0, 4000);
    if (!text) continue;
    attempted += 1;
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
        // specific reason we have, sanitised so a stack trace / file
        // path / internal URL from the encoder does not leak into the
        // memory row's last_embed_error (which the agent can read via
        // memory_status / memory_get / memory_recall).
        const reason = safeErrorMessage(
          lastEmbeddingError() ||
            (process.env.KIMI_MEMORY_EMBEDDINGS === 'off'
              ? 'embeddings disabled (KIMI_MEMORY_EMBEDDINGS=off)'
              : 'embedding model unavailable'),
        );
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
  return {
    scanned: rows.length,
    attempted,
    recovered,
    failed,
    budget_exhausted: budgetExhausted,
  };
}
