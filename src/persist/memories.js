// Memory CRUD + helpers + synthesis + per-row embedding scheduling +
// processing-pipeline promotion + status counts.
//
// Core memory lifecycle lives here. Search, recall, reinforcement,
// edges, sharing, and skills all sit in sibling modules.
import { nowIso, hashId, shortId, safeJsonParse } from '../util.js';
import { looksLikeSecret } from '../extract.js';
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  embedText,
  lastEmbeddingError,
  encodeVector,
} from '../embedding.js';
import { logPersistError } from '../diagnostics.js';
import { VISIBILITY_VALUES, TIER_VALUES_INTERNAL as TIER_VALUES } from './share.js';
import { linkMemory } from './edges.js';

// Re-export statSync for project.js (re-clone detection).
// (Note: actually re-exported from connection.js to avoid a node:fs
// import in this module.)

// --------- Row + id helpers ---------

export function memoryId(projectKey, type, title, content) {
  return shortId(hashId(projectKey, type, title || '', content || ''), 24);
}

export function rowToMemory(row) {
  if (!row) return null;
  // shared_with is a JSON-encoded array of {kind, id} principal
  // descriptors. Safe-parse rather than throw — a corrupt row from a
  // pre-v10 DB should still load and read back as [].
  const sharedParsed = safeJsonParse(row.shared_with || '[]');
  const sharedWith = sharedParsed.ok && Array.isArray(sharedParsed.value) ? sharedParsed.value : [];
  // Each JSON column gets its own try/catch + typed fallback. A single
  // corrupt column (WAL crash mid-write, manual sqlite3 edit, partial
  // import) used to throw and crash the entire `memory_recall` result;
  // now the row degrades to empty arrays/objects and the rest of the
  // set still returns. (Audit finding B2-3.)
  const tags = safeParseJson(row.tags, [], (v) => Array.isArray(v));
  const provenance = safeParseJson(
    row.provenance,
    {},
    (v) => v && typeof v === 'object' && !Array.isArray(v),
  );
  const metadata = safeParseJson(
    row.metadata,
    {},
    (v) => v && typeof v === 'object' && !Array.isArray(v),
  );
  // Surface processing_status as a top-level field for callers that
  // don't want to dig into metadata. Defaults to 'ready' on rows that
  // pre-date the v10 processing pipeline (scaffold tests assert this).
  let processingStatus = 'ready';
  if (metadata && typeof metadata.processing_status === 'string') {
    processingStatus = metadata.processing_status;
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title || '',
    content: row.content,
    tags,
    metadata,
    provenance,
    confidence: row.confidence,
    status: row.status,
    priority: row.priority,
    supersedes: row.supersedes || null,
    superseded_by: row.superseded_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
    processing_status: processingStatus,
    // Lightweight embedding summary — never include the raw BLOB.
    // Three states: 'embedded' (BLOB present), 'pending' (no BLOB
    // yet, no error), 'failed' (no BLOB and a recorded error).
    embedding_status: row.embedding ? 'embedded' : row.last_embed_error ? 'failed' : 'pending',
    embedding_model: row.embedding_model || null,
    last_embed_error: row.last_embed_error || null,
    access_count: row.access_count || 0,
    last_accessed_at: row.last_accessed_at || null,
    // v9 Ebbinghaus fields. Surfaced so the recall layer (and the
    // dashboard) can read the raw stability and rehearsal time without
    // re-querying. Null on pre-v9 rows that have not been touched by
    // the v9 migration yet.
    stability_days: row.stability_days == null ? null : row.stability_days,
    last_rehearsed_at: row.last_rehearsed_at || null,
    // v10 ACL / visibility fields. visibility defaults to 'private' on
    // any pre-v10 row (the column default), and shared_with defaults to
    // an empty list. team_id / agent_id / user_id / session_id / task_id
    // are nullable TEXT — only set when the row was tagged with an
    // identity at write time (e.g. by the hook layer for telemetry).
    visibility: row.visibility || 'private',
    shared_with: sharedWith,
    team_id: row.team_id || null,
    agent_id: row.agent_id || null,
    user_id: row.user_id || null,
    session_id: row.session_id || null,
    task_id: row.task_id || null,
    // v10 tier (Chat Memory L0→L1→L2→L3). Defaults to 'L0' on pre-v10
    // rows (column default). persona_id is nullable — only set when
    // the row is associated with a cross-cutting persona.
    tier: row.tier || 'L0',
    persona_id: row.persona_id || null,
  };
}

// Safe JSON parse for an in-row text column. Returns `fallback` when
// the column is missing, empty, corrupt, or fails the type-guard. Used
// by rowToMemory so a single bad column can't crash `memory_recall`.
// (Audit finding B2-3.)
function safeParseJson(text, fallback, isShape) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return fallback;
  if (typeof isShape === 'function' && !isShape(parsed.value)) return fallback;
  return parsed.value;
}

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
  // Tags and metadata are checked too — the previous version only
  // scanned title and content, leaving a small gap for credentials
  // stashed in tag names or structured metadata.
  // (Audit finding B2-11.)
  const matched = [];
  // Title + content as flat strings.
  for (const name of ['title', 'content']) {
    if (typeof input[name] === 'string' && looksLikeSecret(input[name])) {
      matched.push(name);
    }
  }
  // Each tag value individually — the JSON-encoded array would
  // start with `["` and the existing regex's leading-char boundary
  // would miss a secret that begins at position 0 of a tag.
  if (Array.isArray(input.tags)) {
    for (const t of input.tags) {
      if (typeof t === 'string' && looksLikeSecret(t)) {
        matched.push('tags');
        break;
      }
    }
  }
  // The metadata object's string values, recursively. Stash the
  // serialised JSON as a fallback for shapes the recursion can't
  // reach (e.g. deeply nested arrays of objects).
  function scan(value, path) {
    if (typeof value === 'string') {
      if (looksLikeSecret(value)) matched.push(path);
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) scan(value[i], `${path}[${i}]`);
      return;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) scan(value[k], `${path}.${k}`);
    }
  }
  if (input.metadata && typeof input.metadata === 'object') {
    scan(input.metadata, 'metadata');
  }
  // Provenance is caller-supplied JSON that lands in the row. The
  // prior scan covered only title / content / tags / metadata — a
  // thin shell over metadata could still smuggle a secret through.
  // (Audit finding F-007.)
  if (input.provenance && typeof input.provenance === 'object') {
    scan(input.provenance, 'provenance');
  }
  if (matched.length === 0) return;
  // De-dupe matched paths so the error message is concise.
  const unique = [
    ...new Set(
      matched.map((p) => (p.split(/[.\[]/)[0] === 'metadata' ? 'metadata' : p.split(/[.\[]/)[0])),
    ),
  ];
  const where = unique.length > 1 ? unique.join(' + ') : unique[0];
  const err = new Error(
    `secret_detected: refusing to persist a memory whose ${where} matches a known credential shape. ` +
      `Remove the secret and retry, or set KIMI_MEMORY_SECRET_SCAN=off to bypass.`,
  );
  err.code = 'KIMI_MEMORY_SECRET_DETECTED';
  err.where = where;
  throw err;
}

// --------- CRUD ---------

export function saveMemory(db, projectKey, input) {
  assertNoSecret(input);
  const now = nowIso();
  const id = input.id || memoryId(projectKey, input.type, input.title || '', input.content || '');
  const tags = JSON.stringify(input.tags || []);
  // v10: fold a top-level `processing_status` into metadata so a
  // caller can mark a row as 'pending' (skill extraction in flight)
  // or 'active' without needing to wrap it under metadata. The merge
  // happens here so every existing call site that passes
  // `processing_status` directly still works.
  const baseMeta =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
  const metadata = JSON.stringify(
    input.processing_status
      ? { ...baseMeta, processing_status: input.processing_status }
      : baseMeta,
  );
  const provenance = JSON.stringify(input.provenance || {});
  const confidence =
    typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.8;
  const status = input.status || 'active';
  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0;
  const expires = input.expires_at || null;
  // v10 ACL / visibility fields. visibility defaults to 'private' on
  // every save so a row never accidentally becomes cross-project
  // visible. shared_with defaults to an empty list; principal identity
  // columns (team_id / agent_id / user_id / session_id / task_id) are
  // pass-through TEXT — set by the call site when the row is tagged
  // with a specific principal context (typically the hook layer).
  const visibility = VISIBILITY_VALUES.has(input.visibility) ? input.visibility : 'private';
  const sharedWith = JSON.stringify(Array.isArray(input.shared_with) ? input.shared_with : []);
  const teamId = input.team_id || null;
  const agentId = input.agent_id || null;
  const userId = input.user_id || null;
  const sessionId = input.session_id || null;
  const taskId = input.task_id || null;
  // v10 tier (Chat Memory L0→L1→L2→L3). Defaults to 'L0' so every
  // fresh save is un-promoted. tier-promotion happens via setMemoryTier
  // / promoteMemory / demoteMemory (which write the audit row to
  // persona_promotions). persona_id is pass-through.
  const tier = TIER_VALUES.has(input.tier) ? input.tier : 'L0';
  const personaId = input.persona_id || null;

  // Supersession: when supersede=true and a prior memory with the
  // same (project_key, type, title) is active, mark the prior
  // superseded and record a backlink from the new memory back to it.
  // If no prior exists, the flag is a no-op: the new memory is still
  // created as active. This is intentional — callers that want a
  // pure "replace me" should pair supersede=true with an existing
  // title they intend to replace.
  //
  // The supersede UPDATE + the row write below are wrapped in a
  // SAVEPOINT so a transient INSERT failure (UNIQUE collision, FK
  // violation, SQLITE_BUSY) cannot leave the prior row marked
  // superseded pointing at a non-existent id. The previous shape
  // issued the supersede UPDATE before the INSERT without any
  // transactional safety, so every auto-extract `supersede: true`
  // save (session-focus, work-log, the deterministic stack summary)
  // was exposed to that corruption window. (Audit fix BUG-7.)
  let supersedesId = input.supersedes || null;
  db.exec('SAVEPOINT save_memory_supersede');
  try {
    if (input.supersede) {
      const existing = db
        .prepare(
          "SELECT id FROM memories WHERE project_key = ? AND type = ? AND COALESCE(title,'') = ? AND status = 'active' AND id != ? ORDER BY updated_at DESC",
        )
        .all(projectKey, input.type, input.title || '', id);
      if (existing.length > 0) {
        // Replace only the most-recent prior row. The plural form
        // (marking every match superseded) silently retired distinct
        // memories that happened to share a title — a docstring
        // contract violation. (Audit finding F-002.)
        supersedesId = existing[0].id;
        db.prepare(
          "UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
        ).run(id, now, existing[0].id);
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
            shortId(hashId('edge', projectKey, existing[0].id, id, 'supersedes'), 16),
            projectKey,
            existing[0].id,
            id,
            now,
          );
        } catch {
          /* memory_edges may not exist on a pre-v4 DB; ignore */
        }
      }
    }
    db.exec('RELEASE SAVEPOINT save_memory_supersede');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT save_memory_supersede');
    } catch {
      /* ignore */
    }
    throw e;
  }

  const row = db.prepare('SELECT id, created_at FROM memories WHERE id=?').get(id);
  // Dedicated session-focus column: stamped when the metadata carries
  // the canonical flag. The hook thread's read path queries this
  // column instead of `instr(metadata, '"session_focus":true') > 0`,
  // so the lookup rides idx_memories_session_focus rather than
  // scanning every working row. (Audit flag — session-focus
  // indexability.)
  const isSessionFocus = metadata && /"session_focus":true/.test(metadata) ? 1 : 0;
  // Wrap the row write + FTS reseed + synthesizes edge insert in a
  // single SAVEPOINT opened *above* the row write. The previous shape
  // opened the SAVEPOINT between the row write and the FTS insert,
  // so a throw inside the FTS path could roll back the FTS / synth
  // side while leaving a `memories` row visible to listMemories but
  // invisible to searchMemories (recall depends on the FTS row).
  // (Audit fix H3.)
  db.exec('SAVEPOINT save_memory_upsert');
  try {
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
          visibility = COALESCE(?, visibility),
          shared_with = COALESCE(?, shared_with),
          team_id = COALESCE(?, team_id),
          agent_id = COALESCE(?, agent_id),
          user_id = COALESCE(?, user_id),
          session_id = COALESCE(?, session_id),
          task_id = COALESCE(?, task_id),
          tier = COALESCE(?, tier),
          persona_id = COALESCE(?, persona_id),
          is_session_focus = ?,
          updated_at = ?,
          last_rehearsed_at = ?
        WHERE id = ?
      `,
      ).run(
        input.title ?? null,
        input.content ?? null,
        // `!= null` (not `!== undefined`) — JSON.stringify(null) is
        // the 4-char string "null", which corrupts the column on
        // round-trip. Skip the JSON.stringify entirely for null and
        // fall through to COALESCE so the existing value is
        // preserved. (Audit fix H1.)
        input.tags != null ? JSON.stringify(input.tags) : null,
        input.metadata != null ? JSON.stringify(input.metadata) : null,
        input.provenance != null ? JSON.stringify(input.provenance) : null,
        input.confidence != null ? confidence : null,
        input.status ?? null,
        input.priority != null ? priority : null,
        supersedesId ?? null,
        expires,
        input.visibility ?? null,
        input.shared_with != null ? JSON.stringify(input.shared_with) : null,
        input.team_id ?? null,
        input.agent_id ?? null,
        input.user_id ?? null,
        input.session_id ?? null,
        input.task_id ?? null,
        input.tier ?? null,
        input.persona_id ?? null,
        isSessionFocus,
        now,
        now,
        id,
      );
    } else {
      db.prepare(
        `
        INSERT INTO memories (id, project_key, type, title, content, tags, metadata, provenance, confidence, status, priority, supersedes, created_at, updated_at, expires_at, last_rehearsed_at, visibility, shared_with, team_id, agent_id, user_id, session_id, task_id, tier, persona_id, is_session_focus)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        visibility,
        sharedWith,
        teamId,
        agentId,
        userId,
        sessionId,
        taskId,
        tier,
        personaId,
        isSessionFocus,
      );
    }

    // FTS upsert — wrapped in SAVEPOINT above so a failure rolls the
    // memories row back too, keeping search Memoriestable consistent
    // with the FTS index.
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
    db.exec('RELEASE SAVEPOINT save_memory_upsert');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT save_memory_upsert');
    } catch {
      /* ignore */
    }
    throw e;
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

// --------- Embedding scheduling ---------

// In-flight embedding-promise tracker. saveMemory schedules a microtask
// via scheduleEmbeddingUpdate() below; we register each one in this
// Set so closeDb() / a process.on('SIGTERM') handler can drain them
// before the SQLite handle closes. The promise resolves when the
// embedding row write completes (success or failure path) — including
// the embed_timeout case where embedText returns null. Drain logic
// uses Promise.allSettled so one rejection does not abort the others.
const inFlightEmbeddings = new Set();

function trackEmbedding(promise) {
  inFlightEmbeddings.add(promise);
  // Drop from the set as soon as it settles (success or failure).
  // No-op on rejection: the caller in scheduleEmbeddingUpdate
  // already swallows the error to keep saveMemory synchronous-fail-open.
  promise.finally(() => inFlightEmbeddings.delete(promise));
  return promise;
}

// Drain every in-flight embedding microtask. Called from closeDb() /
// process exit paths so a slow embed-write does not get truncated by
// db.close(). Bounded by a wall-clock cap so a hung encoder cannot
// hold the process open forever; the cap is generous (10 s) so a
// cold-cache model load has a chance to finish on the way out.
export async function flushEmbeddings({ timeoutMs = 10000 } = {}) {
  if (inFlightEmbeddings.size === 0) return { waited: 0 };
  const settled = inFlightEmbeddings.size;
  const drain = Promise.allSettled([...inFlightEmbeddings]);
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  await Promise.race([drain, timer]);
  return { waited: settled };
}

// Async helper: compute embedding for a saved memory and write the
// embedding columns. Never throws — failures are recorded in the
// `last_embed_error` column so the row's `embedding_status` flips
// from 'pending' to 'failed' and the operator can see why.
function scheduleEmbeddingUpdate(db, id, title, content) {
  const job = Promise.resolve().then(async () => {
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
  trackEmbedding(job);
}

// Import here (avoid circular with search.js, which also bumps access)
// — well, if we want bumpAccess in memories.js we need to import it
// from search.js. But search.js imports rowToMemory from memories.js
// already. Let me look at this carefully.

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

// Save N memories atomically inside one transaction. On any error
// the transaction rolls back so the database is unchanged. Useful for
// batch imports that must not partially commit.
//
// Inputs are validated in server.js before they reach this function;
// this layer trusts the shape. Supersede behaviour is identical to
// saveMemory: within a batch, earlier rows can be superseded by later
// rows that share the same (project_key, type, title).
//
// (Audit finding F-001 — partial-commit was a bug; the documented
// all-or-nothing contract is now actually all-or-nothing.)
export function saveMemoryBulk(db, projectKey, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];

  const results = [];

  db.exec('BEGIN');
  try {
    for (let i = 0; i < inputs.length; i++) {
      // saveMemory throws on any error (secret detection, FK / CHECK
      // constraint, validation failure). The outer catch below rolls
      // the whole transaction back, so the batch is genuinely atomic.
      results.push(saveMemory(db, projectKey, inputs[i]));
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  return results;
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

  // Persist the merged into-memory via a direct UPDATE so the
  // title-based supersede logic in saveMemory does not fire (we
  // already have a supersedes relationship from -> into; re-firing it
  // would chain a fresh supersede against any other active row that
  // shares the merged into-title, silently retiring unrelated rows).
  // The previous shape called saveMemory here despite the docstring
  // claim that it "bypasses" the supersede logic — it did not.
  // (Audit fix M2.)
  const now1 = nowIso();
  const mergedContentFinal =
    typeof mergedContent === 'string' && mergedContent.length > 0 ? mergedContent : into.content;
  const isSessionFocus = /"session_focus":true/.test(JSON.stringify(into.metadata || {}));
  db.prepare(
    `UPDATE memories SET
       title = ?,
       content = ?,
       tags = ?,
       metadata = ?,
       provenance = ?,
       confidence = ?,
       status = 'active',
       priority = ?,
       expires_at = ?,
       is_session_focus = ?,
       updated_at = ?
     WHERE id = ? AND project_key = ?`,
  ).run(
    into.title,
    mergedContentFinal,
    JSON.stringify(tags),
    JSON.stringify(into.metadata || {}),
    JSON.stringify(provenance),
    typeof into.confidence === 'number' ? into.confidence : 0.8,
    Number.isFinite(into.priority) ? Math.trunc(into.priority) : 0,
    into.expires_at || null,
    isSessionFocus ? 1 : 0,
    now1,
    into.id,
    projectKey,
  );
  // Re-seed the FTS index so the merged row is searchable by its new
  // content. The DELETE-then-INSERT pair mirrors what saveMemory does
  // and is safe because the FTS5 row is keyed on id only.
  db.prepare('DELETE FROM memories_fts WHERE id=?').run(into.id);
  db.prepare(
    'INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(into.id, projectKey, into.type, into.title, mergedContentFinal, tags.join(' '));
  // Reload so the caller sees the post-merge shape.
  const updated = getMemory(db, projectKey, into.id);

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

// Promote pending rows through the processing pipeline.
// pending -> distilling -> ready (via metadata.processing_status).
export function promotePendingRows(db, projectKey, { limit = 10 } = {}) {
  const cap = Math.max(1, Math.min(10, Math.trunc(limit)));
  const rows = db
    .prepare(
      `SELECT id, metadata FROM memories
       WHERE project_key = ? AND status = 'active'
         AND (instr(metadata, '"processing_status":"pending"') > 0
              OR instr(metadata, '"processing_status":"distilling"') > 0)
       LIMIT ?`,
    )
    .all(projectKey, cap);
  let promoted = 0;
  const now = nowIso();
  const updateStmt = db.prepare(`UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?`);
  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.metadata || '{}');
    } catch {
      meta = {};
    }
    const current = meta.processing_status;
    let next;
    if (current === 'pending') next = 'distilling';
    else if (current === 'distilling') next = 'ready';
    else continue;
    meta.processing_status = next;
    updateStmt.run(JSON.stringify(meta), now, r.id);
    promoted += 1;
  }
  return { promoted };
}

// --------- Status counts ---------

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
// Row-count snapshot used by the dry-run path of memory_reset_project
// (and the matching CLI command). Both call sites need the same six
// counts, so the SELECT statements live here and the call sites
// decorate the result with `reclone` + `total_rows` as needed.
export function resetProjectDryRunCounts(db, projectKey) {
  const get = (sql) => db.prepare(sql).get(projectKey).n;
  return {
    memories: get('SELECT COUNT(*) AS n FROM memories WHERE project_key=?'),
    working_memory: get('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?'),
    conversations: get('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?'),
    conversation_events: get('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?'),
    memory_edges: get('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?'),
    memory_synthesizes: get('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?'),
  };
}
