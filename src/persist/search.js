// Search / recall / backfill.
//
// The RRF (Reciprocal Rank Fusion) hybrid search lives here. Sibling
// modules: memories.js owns CRUD + rowToMemory + getMemory,
// edges.js owns typed edges, share.js owns visibility/tier vocab.
import { nowIso } from '../util.js';
import {
  EMBEDDING_DIM,
  embedText,
  encodeVector,
  decodeVector,
  cosineSimilarity,
} from '../embedding.js';
import { logPersistError } from '../diagnostics.js';
import { rowToMemory } from './memories.js';
import { VISIBILITY_VALUES, TIER_VALUES_INTERNAL as TIER_VALUES } from './share.js';
import { normalizeFts5Query, buildTitleBoostedQuery, buildOrderByClause } from '../search.js';

// Combined-score floor below which a candidate is treated as not
// relevant. Default tuning for the RRF (Reciprocal Rank Fusion) path:
// a row that ranks first in BOTH FTS and vec scores 2/(RRF_K+1) ≈ 0.0328
// at the default RRF_K=60. A row that ranks first in only one channel
// scores 1/61 ≈ 0.0164. The threshold of 0.01 lets every rank-1 hit
// in any channel through and stops a rank-2-only row (≈0.0161) only
// when it loses both channels. Tests that need every FTS candidate
// pass minScore=0.
const MIN_RELEVANCE_SCORE = 0.01;

// RRF (Reciprocal Rank Fusion) constant. Mirrors
// TencentDB-Agent-Memory's RRF_K = 60 in core/store/search-utils.ts.
// score = Σ 1 / (RRF_K + rank_i) summed across every channel that
// ranks the candidate. A missing channel contributes 0 (we pass
// Number.POSITIVE_INFINITY so the contribution cleanly rounds to 0).
// Lower RRF_K sharpens the curve (rank-1 hits dominate more); the
// default 60 is the standard RRF textbook value.
const RRF_K = 60;

// Vector-scan ceiling: bounds the number of embedding BLOBs read into
// Node memory per recall / similarity call. Without this, a project
// with 50k memories pays 50k × 1.5 KB IO on every `memory_similar`
// call. 500 matches the recall-channel cap; tests/16-perf.test.js
// gates the behaviour at 5k-corpus scale.
const RECALL_VECTOR_CAP = 500;

/**
 * Pure RRF combiner. Returns the RRF score for a single candidate.
 *
 * Inputs are channel ranks — 1-indexed, with `Number.POSITIVE_INFINITY`
 * (or any non-finite / sub-1 value) representing "this channel did not
 * rank the candidate". Each finite, positive rank contributes
 * 1 / (k + rank); missing channels contribute 0. The sum is the
 * combined RRF score.
 *
 * This function is exported because (a) it's useful as a unit-tested
 * pure helper and (b) the scaffold test at tests/24-rrf-scoring.test.js
 * imports it directly. Side-effect free; safe to call from any thread.
 */
export function combineRrfScores({ ftsRank, vecRank, k }) {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`combineRrfScores: k must be a positive finite number, got ${k}`);
  }
  const fts = Number.isFinite(ftsRank) && ftsRank >= 1 ? 1 / (k + ftsRank) : 0;
  const vec = Number.isFinite(vecRank) && vecRank >= 1 ? 1 / (k + vecRank) : 0;
  return fts + vec;
}

// Increment access_count and stamp last_accessed_at for the given ids.
// Best-effort: failures (e.g. locked db) are swallowed.
function bumpAccess(db, projectKey, ids) {
  if (!ids || ids.length === 0) return;
  try {
    // One UPDATE statement per recall instead of N round-trips. The
    // previous loop issued O(N) prepared-statement runs wrapped in a
    // BEGIN/COMMIT; on a hot UserPromptSubmit loop that adds up.
    // (Audit finding B2-2.)
    const placeholders = ids.map(() => '?').join(',');
    const now = nowIso();
    db.prepare(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE project_key = ? AND id IN (${placeholders})`,
    ).run(now, projectKey, ...ids);
  } catch (err) {
    // Best-effort: a failed access bump should never break the read
    // path. Log via the diagnostics pipeline so the operator can see
    // the contention pattern in `_diagnostics/hooks.log`.
    logPersistError('bump_access', err, { projectKey, count: ids.length }).catch(() => {});
  }
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
  // Fusion strategy. Default = 'rrf' (Reciprocal Rank Fusion, the
  // TencentDB-aligned path). 'weighted' preserves the legacy 0.5/0.5
  // blend for callers that need it for one release.
  const fusion = opts.fusion === 'weighted' ? 'weighted' : 'rrf';
  const rrfK = Number.isFinite(opts.rrfK) && opts.rrfK > 0 ? opts.rrfK : RRF_K;
  // v10 visibility filter. Accepts either a single visibility string
  // (e.g. 'team') or an array (e.g. ['private', 'team']). Null / empty
  // means "no filter" — preserves the pre-v10 recall surface. The
  // filter is pushed into both the FTS and the vector branches so a
  // restricted row never appears via either channel.
  let visibilityFilter = null;
  if (typeof opts.visibility === 'string' && VISIBILITY_VALUES.has(opts.visibility)) {
    visibilityFilter = [opts.visibility];
  } else if (Array.isArray(opts.visibility)) {
    const filtered = opts.visibility.filter((v) => VISIBILITY_VALUES.has(v));
    if (filtered.length > 0) visibilityFilter = filtered;
  }
  // v10 tier filter. Accepts a single tier (e.g. 'L2') or an array.
  // Tier filtering is independent of the visibility filter — a row
  // can match both gates. Null / omitted = no tier restriction.
  let tierFilter = null;
  if (typeof opts.tier === 'string' && TIER_VALUES.has(opts.tier)) {
    tierFilter = [opts.tier];
  } else if (Array.isArray(opts.tier)) {
    const filtered = opts.tier.filter((v) => TIER_VALUES.has(v));
    if (filtered.length > 0) tierFilter = filtered;
  }
  // v10 per-tier recall budgets. Mirrors TencentDB's
  // `recall.maxResults` + per-tier shaping: a {L0:2, L1:1, L2:1} map
  // caps each tier independently during selection. When omitted,
  // no per-tier shaping is applied.
  const tierBudgets =
    opts.tierBudgets && typeof opts.tierBudgets === 'object' ? opts.tierBudgets : null;
  // v10 recall budgets. maxCharsPerMemory truncates an individual row's
  // content body in the returned payload; maxTotalRecallChars drops
  // rows from the tail once the cumulative sum exceeds the limit.
  const maxCharsPerMemory =
    Number.isFinite(opts.maxCharsPerMemory) && opts.maxCharsPerMemory > 0
      ? Math.floor(opts.maxCharsPerMemory)
      : 0;
  const maxTotalRecallChars =
    Number.isFinite(opts.maxTotalRecallChars) && opts.maxTotalRecallChars > 0
      ? Math.floor(opts.maxTotalRecallChars)
      : 0;

  // ---- 1. FTS5 candidates ----
  // When perType is on we want every type's hits, so we suppress the
  // SQL-level type filter and bucket in memory below.
  const ftsType = perType ? null : type;
  // Use the title-boosted query when title boosting is requested
  // (opts.titleBoost true) or by default for backward parity with the
  // documented IMPROVEMENTS.md §5 surface. The boosted form wraps the
  // query in `title:"q" OR "q"` so FTS5 ranks title matches higher.
  const normalised =
    opts.titleBoost === false ? normalizeFts5Query(query) : buildTitleBoostedQuery(query);
  const ftsRows = [];
  if (normalised) {
    const params = [normalised, projectKey];
    let typeClause = '';
    if (ftsType) {
      typeClause = ' AND m.type = ?';
      params.push(ftsType);
    }
    let visibilityClause = '';
    if (visibilityFilter) {
      visibilityClause = ` AND m.visibility IN (${visibilityFilter.map(() => '?').join(',')})`;
      params.push(...visibilityFilter);
    }
    let tierClause = '';
    if (tierFilter) {
      tierClause = ` AND m.tier IN (${tierFilter.map(() => '?').join(',')})`;
      params.push(...tierFilter);
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
        AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))${typeClause}${visibilityClause}${tierClause}
      ORDER BY rank, m.priority DESC
      LIMIT ?
    `,
        )
        .all(...params),
    );
  }

  // Sort-by handling: when the caller asks for "recent" or "oldest",
  // the FTS has already returned rows in rank order; we re-sort
  // before passing to the diversifier. The fall-through default is
  // the RRF score (computed below).
  const sortBy = opts.sortBy || opts.sort_by || null;
  const recentFirst =
    opts.recentFirst !== undefined
      ? !!opts.recentFirst
      : opts.recent_first !== undefined
        ? !!opts.recent_first
        : null;
  if (sortBy === 'recent' || recentFirst === true) {
    ftsRows.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
  } else if (sortBy === 'oldest') {
    ftsRows.sort((a, b) =>
      a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0,
    );
  }
  // The buildOrderByClause helper is exported for callers that want
  // to compose SQL themselves; the in-memory resort above is what
  // searchMemories actually uses. (Referencing the helper here keeps
  // it from being tree-shaken if a future bundler is aggressive.)
  void buildOrderByClause;

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
    if (visibilityFilter) {
      where.push(`visibility IN (${visibilityFilter.map(() => '?').join(',')})`);
      params.push(...visibilityFilter);
    }
    if (tierFilter) {
      where.push(`tier IN (${tierFilter.map(() => '?').join(',')})`);
      params.push(...tierFilter);
    }
    // Bound the vector scan: every row's embedding BLOB is read into
    // Node memory, so a project with 50k memories pays 50k × 1.5 KB
    // IO per recall. The (project_key, embedding_dim) index drives
    // the WHERE, but capping the IO keeps the hot path bounded at
    // RECALL_VECTOR_CAP rows. RECALL_VECTOR_CAP = limit * 10 gives
    // a comfortable overshoot so the vector channel can still
    // contribute rank-1 hits; tests/16-perf.test.js gates the
    // behaviour at 5k-corpus scale.
    const vectorCap = Math.min(
      RECALL_VECTOR_CAP,
      Math.max(50, (perType ? Math.max(limit * 5, 100) : limit) * 10),
    );
    const rows = db
      .prepare(
        `SELECT id, embedding FROM (
           SELECT id, embedding FROM memories
           WHERE ${where.join(' AND ')}
           ORDER BY randomblob(8)
           LIMIT ?
         )`,
      )
      .all(...params, vectorCap);
    for (const r of rows) {
      const v = decodeVector(r.embedding);
      if (!v || v.length !== EMBEDDING_DIM) continue;
      vecScores.set(r.id, cosineSimilarity(qVec, v));
    }
  }

  // ---- 3. Combine ----
  // Each channel produces a ranked list. We turn each into a
  // {id → rank} map, then run combineRrfScores() over both ranks per
  // candidate. The legacy 'weighted' fusion path (0.5/0.5 blend) is
  // preserved for callers that opt in via `fusion: 'weighted'`; the
  // default is RRF.
  const ftsRank = new Map();
  ftsRows.forEach((row, idx) => ftsRank.set(row.id, idx + 1));
  // vecScores is a Map<id, similarity>. Re-rank by similarity desc to
  // produce vecRank = 1..N. Rows tied on similarity share the lower
  // rank (the first tie wins).
  const vecRank = new Map();
  if (vecScores.size > 0) {
    const sortedVec = [...vecScores.entries()].sort((a, b) => b[1] - a[1]);
    sortedVec.forEach(([id], idx) => vecRank.set(id, idx + 1));
  }
  // Build the union of candidates from both channels. Rows in
  // vecScores but not ftsRows need to be fetched so rowToMemory can
  // surface the full row.
  const merged = new Map();
  for (const row of ftsRows)
    merged.set(row.id, { row, ftsRank: ftsRank.get(row.id), vecRank: Number.POSITIVE_INFINITY });
  if (vecScores.size > 0) {
    const missing = [...vecRank.keys()].filter((id) => !merged.has(id));
    let fetched = new Map();
    if (missing.length > 0) {
      const placeholders = missing.map(() => '?').join(',');
      const fetchedRows = db
        .prepare(`SELECT * FROM memories WHERE project_key=? AND id IN (${placeholders})`)
        .all(projectKey, ...missing);
      fetched = new Map(fetchedRows.map((r) => [r.id, r]));
    }
    for (const [id, rank] of vecRank) {
      const row = merged.get(id)?.row || fetched.get(id);
      if (!row) continue;
      const e = merged.get(id) || {
        row,
        ftsRank: Number.POSITIVE_INFINITY,
        vecRank: Number.POSITIVE_INFINITY,
      };
      e.vecRank = rank;
      merged.set(id, e);
    }
  }

  // ---- 4. Score + relevance filter ----
  // For RRF, score = combineRrfScores(ftsRank, vecRank). For the legacy
  // weighted blend, score = 0.5*ftsScore + 0.5*vecScore. Drop anything
  // below the relevance threshold so a fuzzy FTS hit with no semantic
  // similarity (or vice-versa) does not pollute the recall. Pass
  // minScore=0 to keep every candidate (used by tests).
  // Per-channel score helpers shared by both fusion paths so the
  // includeScore surface always carries fts_score + vec_score (the test
  // at tests/13-recall-per-type.test.js:127 asserts both are numbers).
  // A row that did NOT match a channel gets a 0 score for that channel.
  const ftsScoreOf = (r) => (Number.isFinite(r) && r >= 1 ? 1 / r : 0);
  const vecScoreOf = (rowId) => {
    const sim = vecScores.get(rowId);
    return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0;
  };
  let scored;
  if (fusion === 'rrf') {
    // Surface the rank-decayed per-channel scores alongside the RRF
    // combined score so callers (tests, the agent's [recall] renderer)
    // can verify per-channel attribution. A row that did NOT match a
    // channel gets a 0 score for that channel — the natural RRF "missing
    // channel contributes 0" semantics carry through.
    scored = [...merged.values()].map(({ row, ftsRank, vecRank }) => ({
      row,
      fts_rank: ftsRank,
      vec_rank: vecRank,
      fts_score: ftsScoreOf(ftsRank),
      vec_score: vecScoreOf(row.id),
      rrf_score: combineRrfScores({ ftsRank, vecRank, k: rrfK }),
      score: combineRrfScores({ ftsRank, vecRank, k: rrfK }),
    }));
  } else {
    // Weighted fusion: build pseudo-scores from ranks so the per-channel
    // info is still surfaced when includeScore is true. The rank-decay
    // matches the legacy 1/(idx+1) shape.
    scored = [...merged.values()].map(({ row, ftsRank, vecRank }) => {
      const ftsScore = ftsScoreOf(ftsRank);
      const vecScore = vecScoreOf(row.id);
      return {
        row,
        fts_rank: ftsRank,
        vec_rank: vecRank,
        fts_score: ftsScore,
        vec_score: vecScore,
        score: 0.5 * ftsScore + 0.5 * vecScore,
      };
    });
  }
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

  // v10 per-tier recall budgets. When set, cap each tier independently
  // from the picked list. This runs after perType/global selection so
  // the budgets can down-select a balanced recall to fit the agent's
  // context. Tiers not in the budget map are uncapped.
  if (tierBudgets) {
    const byTier = new Map();
    const remaining = [];
    for (const e of picked) {
      const tier = e.row.tier || 'L0';
      const cap = tierBudgets[tier];
      if (Number.isFinite(cap) && cap >= 0) {
        if (!byTier.has(tier)) byTier.set(tier, []);
        const bucket = byTier.get(tier);
        if (bucket.length < cap) {
          bucket.push(e);
        }
        // Else drop — budget for this tier is full.
      } else {
        remaining.push(e);
      }
    }
    picked = [...remaining, ...[].concat(...byTier.values())].sort((a, b) => b.score - a.score);
  }

  const out = picked.map(({ row, score, fts_rank, vec_rank, rrf_score, fts_score, vec_score }) => {
    const mem = rowToMemory(row);
    if (includeScore) {
      mem.score = score;
      // Always surface ranks and per-channel scores when includeScore
      // is on — including 0 for the channel a row did NOT match.
      // Tests assert `typeof r[0].fts_score === 'number'` and the same
      // for vec_score (tests/13-recall-per-type.test.js:127-128), so a
      // missing channel must be a numeric 0, not `undefined`.
      mem.fts_rank = fts_rank;
      mem.vec_rank = vec_rank;
      if (rrf_score !== undefined) mem.rrf_score = rrf_score;
      mem.fts_score = fts_score || 0;
      mem.vec_score = vec_score || 0;
    }
    return mem;
  });

  // v10 per-row character truncation. maxCharsPerMemory cuts the
  // individual row's content + snippet to the budget; the prefix is
  // preserved verbatim and a "…(truncated)" suffix is appended so the
  // agent can see the cut. Suffix is in code points (surrogate-pair
  // safe) to mirror TencentDB's MIN_TRUNCATED_RECALL_LINE_CHARS =
  // 40 floor on a meaningful truncation length.
  if (maxCharsPerMemory > 0) {
    const TRUNC_SUFFIX = '…(truncated)';
    for (const m of out) {
      if (typeof m.content === 'string' && m.content.length > maxCharsPerMemory) {
        // Slice on a code-point boundary.
        let cut = maxCharsPerMemory;
        while (cut > 0 && (m.content.charCodeAt(cut - 1) & 0xfc00) === 0xdc00) cut -= 1;
        m.content = m.content.slice(0, cut) + TRUNC_SUFFIX;
      }
    }
  }

  // v10 cumulative character cap. Drop tail rows once the running sum
  // of content lengths exceeds maxTotalRecallChars. Keeps the
  // highest-scoring rows the agent can actually fit into context.
  let finalOut = out;
  if (maxTotalRecallChars > 0) {
    let used = 0;
    finalOut = [];
    for (const m of out) {
      const len = typeof m.content === 'string' ? m.content.length : 0;
      if (used + len > maxTotalRecallChars && finalOut.length > 0) break;
      used += len;
      finalOut.push(m);
    }
  }

  // ---- 6. Best-effort access bump on the top results ----
  bumpAccess(
    db,
    projectKey,
    finalOut.map((m) => m.id),
  );

  return finalOut;
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
  // Same candidate cap as the recall channel: every row's embedding
  // BLOB is materialised and decoded, so a 50k-memory project would
  // otherwise pay 50k × 1.5 KB IO on every memory_similar call.
  // (Audit finding F-005.)
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM memories
         WHERE ${where.join(' AND ')}
         ORDER BY randomblob(8)
         LIMIT ?
       )`,
    )
    .all(...params, RECALL_VECTOR_CAP);

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
