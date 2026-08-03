// Memory CRUD: save / list / get / delete / merge, hybrid FTS5 +
// cosine recall, backfill, decay, reinforce, and conclusion
// traversal. Pulls `linkMemory` from edges.js for the merge case and
// uses `looksLikeSecret` from extract.js for the persist-layer secret
// check (defense in depth on top of the auto-extract scrub).
import { nowIso, hashId, shortId } from '../util.js';
import { looksLikeSecret } from '../extract.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embedText,
  lastEmbeddingError,
  encodeVector,
  decodeVector,
  cosineSimilarity,
} from '../embedding.js';
import { linkMemory } from './edges.js';

// Combined-score floor below which a candidate is treated as not
// relevant. The hybrid score is 0.5 * ftsScore + 0.5 * vecScore; in
// FTS-only mode (no embeddings) ftsScore is 1/(rank+1), so the
// threshold roughly means "top 2 FTS hits OR a cosine ≥ ~0.4 OR some
// combination". Tunable per call via the `minScore` option.
const MIN_RELEVANCE_SCORE = 0.2;

export function memoryId(projectKey, type, title, content) {
  return shortId(hashId(projectKey, type, title || '', content || ''), 24);
}

export function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title || '',
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
    provenance: JSON.parse(row.provenance || '{}'),
    confidence: row.confidence,
    status: row.status,
    priority: row.priority,
    supersedes: row.supersedes || null,
    superseded_by: row.superseded_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
    // Lightweight embedding summary — never include the raw BLOB.
    // Three states: 'embedded' (BLOB present), 'pending' (no BLOB
    // yet, no error), 'failed' (no BLOB and a recorded error).
    embedding_status: row.embedding ? 'embedded' : row.last_embed_error ? 'failed' : 'pending',
    embedding_model: row.embedding_model || null,
    last_embed_error: row.last_embed_error || null,
    access_count: row.access_count || 0,
    last_accessed_at: row.last_accessed_at || null,
  };
}

// ----- CRUD -----

// Defense in depth: refuse to persist a memory whose title or content
// matches a known credential shape. The auto-extract path already
// scrubs candidates before this point, but `memory_save` and
// `memory_update` are exposed directly to the agent — a misbehaving
// model reply, a follow-the-instructions prompt-injection, or a user
// asking the agent to "remember my API key" would otherwise land the
// secret in the durable store. The check is opt-out via
// KIMI_MEMORY_SECRET_SCAN=off for the rare case where a user genuinely
// needs to persist a secret-shaped string (e.g. an example fixture).
// False positives are accepted: dropping a candidate that mentions a
// generic "api_key" is far cheaper than persisting a real one.
function assertNoSecret(input) {
  if (process.env.KIMI_MEMORY_SECRET_SCAN === 'off') return;
  const titleMatch = input.title && looksLikeSecret(input.title);
  const contentMatch = input.content && looksLikeSecret(input.content);
  if (titleMatch || contentMatch) {
    const where =
      titleMatch && contentMatch ? 'title and content' : titleMatch ? 'title' : 'content';
    const err = new Error(
      `secret_detected: refusing to persist a memory whose ${where} matches a known credential shape. ` +
        `Remove the secret and retry, or set KIMI_MEMORY_SECRET_SCAN=off to bypass.`,
    );
    err.code = 'KIMI_MEMORY_SECRET_DETECTED';
    err.where = where;
    throw err;
  }
}

export function saveMemory(db, projectKey, input) {
  assertNoSecret(input);
  const now = nowIso();
  const id = input.id || memoryId(projectKey, input.type, input.title || '', input.content || '');
  const tags = JSON.stringify(input.tags || []);
  const metadata = JSON.stringify(input.metadata || {});
  const provenance = JSON.stringify(input.provenance || {});
  const confidence =
    typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.8;
  const status = input.status || 'active';
  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0;
  const expires = input.expires_at || null;

  // Supersession: when supersede=true and a prior memory with the
  // same (project_key, type, title) is active, mark the prior
  // superseded and record a backlink from the new memory back to it.
  // If no prior exists, the flag is a no-op: the new memory is still
  // created as active. This is intentional — callers that want a
  // pure "replace me" should pair supersede=true with an existing
  // title they intend to replace.
  let supersedesId = input.supersedes || null;
  if (input.supersede) {
    const existing = db
      .prepare(
        "SELECT id FROM memories WHERE project_key = ? AND type = ? AND COALESCE(title,'') = ? AND status = 'active' AND id != ? ORDER BY updated_at DESC",
      )
      .all(projectKey, input.type, input.title || '', id);
    if (existing.length > 0) {
      // Link back to the most-recent prior; mark every prior superseded.
      supersedesId = existing[0].id;
      for (const ex of existing) {
        db.prepare(
          "UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
        ).run(id, now, ex.id);
      }
      // Record a typed supersedes edge in memory_edges so the new
      // graph primitive stays the canonical source going forward.
      // Deduped via UNIQUE(project_key, from_id, to_id, kind); the
      // edge primitive is idempotent.
      try {
        db.prepare(
          `
          INSERT OR IGNORE INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)
          VALUES (?, ?, ?, ?, 'supersedes', 1.0, ?)
        `,
        ).run(
          shortId(hashId('edge', projectKey, ex.id, id, 'supersedes'), 16),
          projectKey,
          ex.id,
          id,
          now,
        );
      } catch {
        /* memory_edges may not exist on a pre-v4 DB; ignore */
      }
    }
  }

  const row = db.prepare('SELECT id, created_at FROM memories WHERE id=?').get(id);
  if (row) {
    db.prepare(
      `
      UPDATE memories SET
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        tags = COALESCE(?, tags),
        metadata = COALESCE(?, metadata),
        provenance = COALESCE(?, provenance),
        confidence = COALESCE(?, confidence),
        status = COALESCE(?, status),
        priority = COALESCE(?, priority),
        supersedes = COALESCE(?, supersedes),
        expires_at = COALESCE(?, expires_at),
        updated_at = ?
      WHERE id = ?
    `,
    ).run(
      input.title ?? null,
      input.content ?? null,
      input.tags !== undefined ? JSON.stringify(input.tags) : null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      input.provenance !== undefined ? JSON.stringify(input.provenance) : null,
      input.confidence != null ? confidence : null,
      input.status ?? null,
      input.priority != null ? priority : null,
      supersedesId ?? null,
      expires,
      now,
      id,
    );
  } else {
    db.prepare(
      `
      INSERT INTO memories (id, project_key, type, title, content, tags, metadata, provenance, confidence, status, priority, supersedes, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      projectKey,
      input.type,
      input.title || '',
      input.content || '',
      tags,
      metadata,
      provenance,
      confidence,
      status,
      priority,
      supersedesId,
      now,
      now,
      expires,
    );
  }

  // FTS upsert
  db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
  db.prepare(
    'INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    projectKey,
    input.type,
    input.title || '',
    input.content || '',
    (input.tags || []).join(' '),
  );

  // Conclusion edge: record this memory's synthesizes[] children in
  // memory_synthesizes so bidirectional lookup is a single indexed
  // query. Skip empty / duplicate / self-references. Idempotent via
  // PRIMARY KEY (parent_id, child_id); re-saving just re-stamps the
  // created_at, which is what callers usually want.
  const synth = Array.isArray(input.synthesizes) ? input.synthesizes : null;
  if (synth && synth.length > 0) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO memory_synthesizes (parent_id, child_id, project_key, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const childId of synth) {
      if (typeof childId !== 'string' || childId === id) continue;
      try {
        stmt.run(id, childId, projectKey, now);
      } catch {
        /* child missing in same scope; ignore */
      }
    }
  }

  const saved = getMemory(db, projectKey, id);

  // Fire-and-forget embedding update. Runs as a microtask so saveMemory
  // itself stays synchronous (existing tests and callers depend on that).
  // Failures inside the embedding module are already logged via warnOnce;
  // they never bubble up here. Pass _embed:false to skip (used by tests).
  if (input._embed !== false && process.env.KIMI_MEMORY_EMBEDDINGS !== 'off') {
    scheduleEmbeddingUpdate(db, id, saved?.title || '', saved?.content || '');
  }

  return saved;
}

// Read every conclusion that synthesizes a given memory. The argument
// is a *child* memory id; we return the parent conclusions.
export function listConclusionsFor(db, projectKey, childId, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT m.* FROM memories m
    JOIN memory_synthesizes s ON s.parent_id = m.id
    WHERE s.child_id = ? AND s.project_key = ?
      AND m.status = 'active'
    ORDER BY m.priority DESC, datetime(m.updated_at) DESC
    LIMIT ?
  `,
    )
    .all(childId, projectKey, Math.max(1, Math.min(200, limit)));
  return rows.map(rowToMemory);
}

// Inverse of listConclusionsFor: given a conclusion's id, return the
// underlying memories it synthesizes.
export function getParents(db, projectKey, conclusionId, { limit = 200 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT m.* FROM memories m
    JOIN memory_synthesizes s ON s.child_id = m.id
    WHERE s.parent_id = ? AND s.project_key = ?
      AND m.status = 'active'
    ORDER BY m.priority DESC, datetime(m.updated_at) DESC
    LIMIT ?
  `,
    )
    .all(conclusionId, projectKey, Math.max(1, Math.min(500, limit)));
  return rows.map(rowToMemory);
}

// Async helper: compute embedding for a saved memory and write the
// embedding columns. Never throws — failures are recorded in the
// `last_embed_error` column so the row's `embedding_status` flips
// from 'pending' to 'failed' and the operator can see why.
function scheduleEmbeddingUpdate(db, id, title, content) {
  Promise.resolve().then(async () => {
    let vec = null;
    let embedErr = null;
    try {
      const text = `${title || ''}\n${content || ''}`.trim().slice(0, 4000);
      if (!text) return;
      vec = await embedText(text);
    } catch (e) {
      embedErr = e && e.message ? e.message : String(e);
    }
    // Re-check the row still exists; could have been deleted between
    // save and this microtask.
    let stillThere = null;
    try {
      stillThere = db.prepare('SELECT id FROM memories WHERE id=?').get(id);
    } catch (e) {
      // The DB itself is unavailable — nothing useful we can do.
      return;
    }
    if (!stillThere) return;
    try {
      if (vec) {
        db.prepare(
          `UPDATE memories
                    SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?,
                        last_embed_error=NULL
                    WHERE id=?`,
        ).run(encodeVector(vec), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), id);
      } else {
        // No vector returned and no exception either: the embedding
        // module is opted out (KIMI_MEMORY_EMBEDDINGS=off), the
        // encoder timed out within its wall-clock budget, or the
        // model is unavailable. Prefer the most specific reason
        // available — `lastEmbeddingError()` carries the timeout
        // message or the real error from the import / pipe — and
        // fall back to a generic one for the cold-cache case where
        // we never reached the encoder at all.
        const reason =
          embedErr ||
          lastEmbeddingError() ||
          (process.env.KIMI_MEMORY_EMBEDDINGS === 'off'
            ? 'embeddings disabled (KIMI_MEMORY_EMBEDDINGS=off)'
            : 'embedding model unavailable');
        db.prepare(
          `UPDATE memories
                    SET last_embed_error=?, embedded_at=?
                    WHERE id=?`,
        ).run(reason, nowIso(), id);
      }
    } catch {
      /* DB write failed; nothing else we can do here */
    }
  });
}

// Increment access_count and stamp last_accessed_at for the given ids.
// Best-effort: failures (e.g. locked db) are swallowed.
function bumpAccess(db, projectKey, ids) {
  if (!ids || ids.length === 0) return;
  try {
    const stmt = db.prepare(`UPDATE memories
                              SET access_count = access_count + 1, last_accessed_at = ?
                              WHERE project_key = ? AND id = ?`);
    const now = nowIso();
    db.exec('BEGIN');
    for (const id of ids) stmt.run(now, projectKey, id);
    db.exec('COMMIT');
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
  }
}

// Save N memories atomically inside one transaction. On any error
// the transaction rolls back so the database is unchanged. Useful for
// batch imports that must not partially commit.
//
// Inputs are validated in server.js before they reach this function;
// this layer trusts the shape. Supersede behaviour is identical to
// saveMemory: within a batch, earlier rows can be superseded by later
// rows that share the same (project_key, type, title).
export function saveMemoryBulk(db, projectKey, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  db.exec('BEGIN');
  try {
    const out = [];
    for (const input of inputs) {
      out.push(saveMemory(db, projectKey, input));
    }
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function getMemory(db, projectKey, id, { includeSuperseded = false } = {}) {
  const row = db.prepare('SELECT * FROM memories WHERE id=? AND project_key=?').get(id, projectKey);
  if (!row) return null;
  if (row.status === 'deleted') return null;
  if (row.status === 'superseded' && !includeSuperseded) return null;
  // Expiry check
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ...rowToMemory(row), expired: true };
  }
  return rowToMemory(row);
}

export function listMemories(
  db,
  projectKey,
  { type, status = 'active', limit = 50, offset = 0, includeExpired = false } = {},
) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (!includeExpired) where.push("(expires_at IS NULL OR datetime(expires_at) > datetime('now'))");
  const sql = `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY priority DESC, datetime(updated_at) DESC LIMIT ? OFFSET ?`;
  params.push(Math.max(1, Math.min(500, limit)), Math.max(0, offset));
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToMemory);
}

export function deleteMemory(db, projectKey, id, { hard = false } = {}) {
  if (hard) {
    db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
    const r = db.prepare('DELETE FROM memories WHERE id=? AND project_key=?').run(id, projectKey);
    return r.changes > 0;
  }
  const now = nowIso();
  const r = db
    .prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=? AND project_key=?")
    .run(now, id, projectKey);
  if (r.changes) {
    db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
  }
  return r.changes > 0;
}

export async function searchMemories(db, projectKey, query, opts = {}) {
  if (!query || !query.trim()) return [];
  const limit = Math.max(1, Math.min(200, opts.limit || 20));
  const type = opts.type || null;
  const minScore =
    Number.isFinite(opts.minScore) && opts.minScore >= 0 && opts.minScore <= 1
      ? opts.minScore
      : MIN_RELEVANCE_SCORE;
  // perType: when true, pick the top `perTypeLimit` rows from EACH
  // type that has a hit, then sort by score and take the global top
  // `limit`. Use this when you want a balanced recall (e.g. the
  // UserPromptSubmit hook, so the agent sees a mix of conventions,
  // procedures, and working notes rather than the top-N of one type).
  // The SQL-level `type` filter is ignored when perType is set — a
  // type filter plus per-type balancing is contradictory.
  const perType = !!opts.perType;
  const perTypeLimit = Math.max(1, Math.min(20, opts.perTypeLimit || 2));
  const includeScore = !!opts.includeScore;

  // ---- 1. FTS5 candidates ----
  // When perType is on we want every type's hits, so we suppress the
  // SQL-level type filter and bucket in memory below.
  const ftsType = perType ? null : type;
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  const ftsRows = [];
  if (tokens.length > 0) {
    const fts = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    const params = [fts, projectKey];
    let typeClause = '';
    if (ftsType) {
      typeClause = ' AND m.type = ?';
      params.push(ftsType);
    }
    // Cast a wide net for perType: pull up to `limit * 5` rows so
    // every type has a chance to be represented.
    params.push(perType ? Math.max(limit * 5, 100) : limit);
    ftsRows.push(
      ...db
        .prepare(
          `
      SELECT m.* FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ?
        AND m.project_key = ?
        AND m.status = 'active'
        AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))${typeClause}
      ORDER BY rank, m.priority DESC
      LIMIT ?
    `,
        )
        .all(...params),
    );
  }

  // ---- 2. Vector candidates (best-effort, fail-open) ----
  // Compute the query embedding once, then cosine-similarity against
  // every active memory in this project that has an embedding of the
  // expected dimension. Embedding module never throws; null = skip.
  const qVec = await embedText(query);
  const vecScores = new Map();
  if (qVec && qVec.length === EMBEDDING_DIM) {
    const where = [
      'project_key = ?',
      "status = 'active'",
      "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
      'embedding IS NOT NULL',
      'embedding_dim = ?',
    ];
    const params = [projectKey, EMBEDDING_DIM];
    if (!perType && type) {
      where.push('type = ?');
      params.push(type);
    }
    const rows = db
      .prepare(`SELECT id, embedding FROM memories WHERE ${where.join(' AND ')}`)
      .all(...params);
    for (const r of rows) {
      const v = decodeVector(r.embedding);
      if (!v || v.length !== EMBEDDING_DIM) continue;
      vecScores.set(r.id, cosineSimilarity(qVec, v));
    }
  }

  // ---- 3. Combine ----
  // Hybrid score = 0.5 * ftsScore + 0.5 * vecScore, where ftsScore is a
  // rank-based decay (1/(rank+1)) so top FTS hits beat later ones. A
  // memory only present in one channel still gets a non-zero score; the
  // combined value is a fair ranking signal either way.
  const ftsScored = ftsRows.map((row, idx) => ({ id: row.id, row, ftsScore: 1 / (idx + 1) }));
  const merged = new Map();
  for (const e of ftsScored) merged.set(e.id, { row: e.row, ftsScore: e.ftsScore, vecScore: 0 });

  if (vecScores.size > 0) {
    // Build a lookup for any vector-only rows we need to fetch.
    const missing = [...vecScores.keys()].filter((id) => !merged.has(id));
    let fetched = new Map();
    if (missing.length > 0) {
      const placeholders = missing.map(() => '?').join(',');
      const fetchedRows = db
        .prepare(`SELECT * FROM memories WHERE project_key=? AND id IN (${placeholders})`)
        .all(projectKey, ...missing);
      fetched = new Map(fetchedRows.map((r) => [r.id, r]));
    }
    for (const [id, sim] of vecScores) {
      const row = merged.get(id)?.row || fetched.get(id);
      if (!row) continue;
      const e = merged.get(id) || { row, ftsScore: 0, vecScore: 0 };
      e.vecScore = sim;
      merged.set(id, e);
    }
  }

  // ---- 4. Score + relevance filter ----
  // Drop anything below the relevance threshold so a fuzzy FTS hit
  // with no semantic similarity (or vice-versa) does not pollute the
  // recall. Pass minScore=0 to keep every candidate (used by tests).
  let scored = [...merged.values()].map(({ row, ftsScore, vecScore }) => ({
    row,
    ftsScore,
    vecScore,
    score: 0.5 * ftsScore + 0.5 * Math.max(0, Math.min(1, vecScore)),
  }));
  if (minScore > 0) scored = scored.filter((e) => e.score >= minScore);

  // ---- 5. Selection ----
  let picked;
  if (perType) {
    // Bucket by type, take top perTypeLimit per type, then re-sort
    // by score and trim to the global `limit`. Guarantees the agent
    // sees at least one row from every type that has a hit.
    const byType = new Map();
    for (const e of scored) {
      const t = e.row.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(e);
    }
    picked = [];
    for (const items of byType.values()) {
      items.sort((a, b) => b.score - a.score);
      picked.push(...items.slice(0, perTypeLimit));
    }
    picked.sort((a, b) => b.score - a.score);
    picked = picked.slice(0, limit);
  } else {
    scored.sort((a, b) => b.score - a.score);
    picked = scored.slice(0, limit);
  }

  const out = picked.map(({ row, score, ftsScore, vecScore }) => {
    const mem = rowToMemory(row);
    if (includeScore) {
      mem.score = score;
      mem.fts_score = ftsScore;
      mem.vec_score = vecScore;
    }
    return mem;
  });

  // ---- 6. Best-effort access bump on the top results ----
  bumpAccess(
    db,
    projectKey,
    out.map((m) => m.id),
  );

  return out;
}

// Find memories semantically similar to a given memory id (cosine
// over stored embeddings). Returns [] if the target has no embedding
// (e.g. legacy row, embedding model unavailable).
export async function similarMemories(db, projectKey, id, { limit = 10, threshold = 0.6 } = {}) {
  const target = db
    .prepare('SELECT id, embedding, embedding_dim FROM memories WHERE id=? AND project_key=?')
    .get(id, projectKey);
  if (!target || !target.embedding) return [];
  const tVec = decodeVector(target.embedding);
  if (!tVec || tVec.length !== EMBEDDING_DIM) return [];

  const where = [
    'project_key = ?',
    'id != ?',
    "status = 'active'",
    "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
    'embedding IS NOT NULL',
    'embedding_dim = ?',
  ];
  const params = [projectKey, id, EMBEDDING_DIM];
  const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}`).all(...params);

  const scored = [];
  for (const row of rows) {
    const v = decodeVector(row.embedding);
    if (!v || v.length !== EMBEDDING_DIM) continue;
    const sim = cosineSimilarity(tVec, v);
    if (sim >= threshold) scored.push({ row, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, Math.max(1, Math.min(50, limit)));

  if (top.length > 0) {
    bumpAccess(
      db,
      projectKey,
      top.map((s) => s.row.id),
    );
  }

  return top.map(({ row, sim }) => ({
    ...rowToMemory(row),
    similarity: sim,
  }));
}

// Backfill embeddings for rows that don't have one yet. Idempotent:
// safe to re-run. Returns counts. Used by `npm run backfill-embeddings`
// and exposed to the dashboard.
export async function backfillEmbeddings(db, projectKey, { batchSize = 50, force = false } = {}) {
  const where = ['project_key = ?', "status = 'active'"];
  const params = [projectKey];
  if (!force) where.push('embedding IS NULL');
  const rows = db
    .prepare(
      `SELECT id, title, content FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
    )
    .all(...params);

  let embedded = 0,
    skipped = 0,
    failed = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const r of batch) {
      try {
        const text = `${r.title || ''}\n${r.content || ''}`.trim().slice(0, 4000);
        const vec = await embedText(text);
        if (!vec) {
          skipped++;
          continue;
        }
        db.prepare(
          `UPDATE memories
                      SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?
                      WHERE id=?`,
        ).run(encodeVector(vec), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), r.id);
        embedded++;
      } catch {
        failed++;
      }
    }
  }
  return { scanned: rows.length, embedded, skipped, failed };
}

// ----- Importance + decay (signal-driven reinforcement) -----

// Single-row bump for "this memory helped": +1 access, stamp the time,
// and nudge confidence toward 1.0. The nudge is small (0.05) so a
// single reinforce isn't enough to rescue a low-quality memory — it
// rewards consistently-useful memories over many calls, mirroring how
// a real recall signal accumulates over time.
const REINFORCE_DELTA = 0.05;

export function reinforceMemory(db, projectKey, id) {
  const now = nowIso();
  const row = db
    .prepare("SELECT id, confidence FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(id, projectKey);
  if (!row) return null;
  const next = Math.min(1, Math.max(0, (row.confidence || 0) + REINFORCE_DELTA));
  db.prepare(
    `
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed_at = ?,
        confidence = ?
    WHERE id = ? AND project_key = ?
  `,
  ).run(now, next, id, projectKey);
  return getMemory(db, projectKey, id);
}

// Idempotent, best-effort decay pass. Decreases confidence on every
// active memory that has not been touched in 30+ days, scaled by the
// length of the inactivity. Floor 0.1 so a memory never fully "dies"
// from disuse alone — soft-delete (`memory_delete`) is the right tool
// for permanent removal. Used by the SessionStart hook (hooks/decay.js)
// and exposed for dashboards / CLI use.
const DECAY_DAYS = 30;
const DECAY_RATE_PER_DAY = 0.05 / DECAY_DAYS; // 5% per 30 days
const DECAY_FLOOR = 0.1;

export function decayMemories(db, projectKey, { now = nowIso() } = {}) {
  // One UPDATE statement covers every row — no per-row roundtrip.
  // inactivity_days = max(0, days(now - COALESCE(last_accessed_at, updated_at)) - DECAY_DAYS)
  // so the first 30 days are a grace period; only memories stale beyond
  // that lose confidence.
  const r = db
    .prepare(
      `
    UPDATE memories
    SET confidence = MAX(
      ?,
      confidence * (1.0 - ? * MAX(
        0.0,
        julianday(?) - julianday(COALESCE(last_accessed_at, updated_at)) - ?
      ))
    )
    WHERE project_key = ?
      AND status = 'active'
      AND julianday(?) - julianday(COALESCE(last_accessed_at, updated_at)) > ?
  `,
    )
    .run(DECAY_FLOOR, DECAY_RATE_PER_DAY, now, DECAY_DAYS, projectKey, now, DECAY_DAYS);
  return { affected: r.changes };
}

// Merge `fromId` into `intoId`. Behaviour:
//   - intoId gains a union of tags from both memories (existing tags preserved, new ones appended).
//   - intoId gains a merge entry in its provenance: { source: 'memory_merge', merged_from: fromId, ... }.
//   - fromId is soft-superseded (status='superseded', superseded_by=intoId).
//   - fromId is removed from FTS so it no longer matches recall.
//   - A 'supersedes' edge (from -> into) is recorded in memory_edges.
//   - If opts.mergedContent is provided, intoId's content is replaced.
// Returns { into, from, edge }. Throws if either id is missing / soft-deleted.
export function mergeMemory(
  db,
  projectKey,
  intoId,
  fromId,
  { mergedContent = null, weight = 1.0 } = {},
) {
  if (!intoId || !fromId) throw new Error('mergeMemory: intoId and fromId are required');
  if (intoId === fromId) throw new Error('mergeMemory: intoId and fromId must differ');

  const into = getMemory(db, projectKey, intoId, { includeSuperseded: true });
  const from = getMemory(db, projectKey, fromId, { includeSuperseded: true });
  if (!into) throw new Error(`mergeMemory: into memory not found: ${intoId}`);
  if (!from) throw new Error(`mergeMemory: from memory not found: ${fromId}`);

  // Union tags (preserve order, de-dup case-insensitively).
  const seen = new Set();
  const tags = [];
  for (const t of into.tags || []) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }
  for (const t of from.tags || []) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }

  // Build the new provenance: copy into's, append a merge entry that
  // records where the trailing tags came from.
  const provenance = { ...(into.provenance || {}) };
  provenance.merged_from = Array.isArray(provenance.merged_from) ? provenance.merged_from : [];
  provenance.merged_from.push({
    id: from.id,
    merged_at: nowIso(),
    kind: 'memory_merge',
  });

  // Persist the merged into-memory. We call saveMemory directly so we
  // bypass its supersede-on-same-title logic (we already have a
  // supersedes relationship from -> into).
  const merged = {
    id: into.id,
    type: into.type,
    title: into.title,
    content:
      typeof mergedContent === 'string' && mergedContent.length > 0 ? mergedContent : into.content,
    tags,
    metadata: into.metadata || {},
    provenance,
    confidence: into.confidence,
    status: 'active',
    priority: into.priority || 0,
    expires_at: into.expires_at || null,
    // _embed:false keeps saveMemory sync and skips the embedding
    // microtask — the merged content already has the same or similar
    // embedding as before; the next backfill will refresh if needed.
    _embed: false,
  };
  const updated = saveMemory(db, projectKey, merged);

  // Soft-supersede the from-memory and stamp a back-link. Use raw SQL
  // so we don't re-fire saveMemory's title-based supersede logic (which
  // would chase a chain).
  const now = nowIso();
  db.prepare(
    `
    UPDATE memories
    SET status='superseded', superseded_by=?, updated_at=?
    WHERE id=? AND project_key=?
  `,
  ).run(intoId, now, fromId, projectKey);
  db.prepare('DELETE FROM memories_fts WHERE id=?').run(fromId);

  // Record the typed supersedes edge in memory_edges so consumers of
  // the new graph primitive see the relationship too.
  const edge = linkMemory(db, projectKey, fromId, intoId, 'supersedes', { weight });

  // Reload from-side so the caller sees the soft-superseded status.
  const after = db
    .prepare('SELECT * FROM memories WHERE id=? AND project_key=?')
    .get(fromId, projectKey);
  return {
    into: updated,
    from: after ? { ...rowToMemory(after), status: 'superseded', superseded_by: intoId } : null,
    edge,
  };
}

// Count-only breakdown for one database (project or global). Pass the
// already-open db handle plus the project_key value (a SHA-256 prefix
// for project DBs, or the literal "_global" string for the global DB).
export function memoryCounts(db, projectKey) {
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
    .get(projectKey).n;
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
    )
    .get(projectKey).n;
  const expired = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')",
    )
    .get(projectKey).n;
  const superseded = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='superseded'")
    .get(projectKey).n;
  const deleted = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='deleted'")
    .get(projectKey).n;
  const retained = expired + superseded + deleted;
  const byType = db
    .prepare(
      "SELECT type, COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) GROUP BY type",
    )
    .all(projectKey);
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM memories WHERE project_key=? GROUP BY status')
    .all(projectKey);
  const latestRow = db
    .prepare('SELECT MAX(updated_at) AS t FROM memories WHERE project_key=?')
    .get(projectKey);
  return {
    // `total` is preserved as a compatibility field: every row in the
    // memories table for this key, regardless of status. The accurate
    // "currently forceable" count is `active`, and the still-on-disk
    // but no-longer-in-force count is `retained`.
    total,
    active,
    retained,
    expired,
    superseded,
    deleted,
    by_type: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    latest_update_at: latestRow && latestRow.t ? latestRow.t : null,
  };
}

// Backward-compatibility wrapper around memoryCounts. Top-level fields
// describe the project's own durable + working memory + conversations,
// matching the shape returned by earlier versions of this plugin.
export function projectStatus(db, projectKey) {
  const mem = memoryCounts(db, projectKey);
  const wm = db
    .prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?')
    .get(projectKey).n;
  const conv = db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
    .get(projectKey).n;
  const events = db
    .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
    .get(projectKey).n;
  return {
    project_key: projectKey,
    memories: mem,
    working_memory_slots: wm,
    conversations: conv,
    conversation_events: events,
  };
}
