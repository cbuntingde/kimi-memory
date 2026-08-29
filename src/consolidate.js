// Background "dream" consolidation pass.
//
// Walks the project's active memories, clusters them by embedding
// cosine (≥ CONSOLIDATE_THRESHOLD) AND tag overlap (≥ MIN_TAG_OVERLAP),
// and for each cluster of ≥ MIN_CLUSTER_SIZE sibling memories that
// has no existing `conclusion` child, writes one new `conclusion`-typed
// memory that links them via memory_synthesizes + memory_edges.
//
// Why: the `conclusion` type and the synthesizes edge primitive already
// exist; nothing was *creating* them automatically. The consolidation
// pass fills that gap without an LLM call. The body of the conclusion
// is a deterministic join of the child titles + first content line, so
// the operator can grep the dashboard and read the synthesis directly.
//
// Idempotency: before writing, we check memory_synthesizes for any
// existing row that already covers (>=75% of) the candidate cluster.
// That makes a re-run on a project with existing conclusions a no-op.
//
// Cost: O(N²) over the project's embedding matrix is fine for N<200
// (the practical working set). Above that we cap by CONSOLIDATE_MAX_CLUSTERS
// and CONSOLIDATE_MAX_MEMBERS so a 10k-memory DB does not pin the hook.
//
// Fail-open: every step is wrapped. The hook layer swallows exceptions
// and reports counts via { saved, skipped, errors, error? }.

import { nowIso, hashId, shortId } from './util.js';
import { AUTO_MERGE_THRESHOLDS } from './auto-gc.js';

const CONSOLIDATE_THRESHOLD = 0.75; // cosine floor for "related enough"
// MIN_TAG_OVERLAP dropped 2 → 1 in v15: real-world memories usually carry
// 1–2 tags, so "2 shared tags" was the dominant reason small datasets
// never formed a cluster. Cosine ≥ 0.75 still anchors the clusterer on
// semantic similarity; the only relaxation is the tag-side filter.
const MIN_TAG_OVERLAP = 1;
const MIN_CLUSTER_SIZE = 3; // need >=3 siblings to synthesise
const CONSOLIDATE_MAX_MEMBERS = 8; // cap cluster size to keep conclusion bodies readable
const CONSOLIDATE_MAX_CLUSTERS = 20; // cap clusters per pass
const COVERAGE_RATIO = 0.75; // an existing conclusion "covers" a cluster if >=75% of the cluster is already linked

// Small-dataset escape. When the project carries fewer than this many
// active memories, drop the tag-overlap filter entirely (cosine alone
// decides). This is the difference between "the inline pass did
// nothing because the project has 6 memories" and "the inline pass
// caught 2 sibling pairs".
const SMALL_DATASET_THRESHOLD = 10;

// KIMI_MEMORY_CONSOLIDATE_RELAX=on (default on) gates the small-dataset
// escape. Off restores strict tag-overlap behaviour.
function isRelaxEnabled() {
  const v = process.env.KIMI_MEMORY_CONSOLIDATE_RELAX;
  return v === undefined || v === 'on';
}

// Effective tag-overlap floor, given the active memories count.
function effectiveTagOverlap(memoryCount) {
  if (!isRelaxEnabled()) return MIN_TAG_OVERLAP;
  if (memoryCount < SMALL_DATASET_THRESHOLD) return 0;
  return MIN_TAG_OVERLAP;
}

function tokenizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).toLowerCase().trim()).filter((t) => t.length > 0);
}

function tagOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const t of b) if (set.has(t)) shared += 1;
  return shared;
}

// Load every active memory that has an embedding. Embedding-pending
// rows are skipped — they cannot be cosine-clustered. Their day will
// come on the next pass.
//
// Cap the input size at CONSOLIDATE_INPUT_CAP so the O(N²) cosine loop
// in clusterMemories stays bounded even on huge projects. The cap is
// (max clusters) × (max members) × 4 — plenty of headroom for the
// clusterer's intended use and a hard wall against a 10k-memory DB
// stalling the SessionStart hook. Rows are ordered by updated_at DESC
// so the freshest memories (the ones the user is most likely to want
// summarised) are preferred over ancient ones.
const CONSOLIDATE_INPUT_CAP = CONSOLIDATE_MAX_CLUSTERS * CONSOLIDATE_MAX_MEMBERS * 4; // 640 rows
function loadActiveMemories(db, projectKey) {
  return db
    .prepare(
      `SELECT id, type, title, content, tags, embedding, embedding_dim, confidence, updated_at
       FROM memories
       WHERE project_key = ?
         AND status = 'active'
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         AND embedding IS NOT NULL
         AND embedding_dim IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(projectKey, CONSOLIDATE_INPUT_CAP)
    .map((r) => {
      let tags = [];
      try {
        tags = JSON.parse(r.tags || '[]');
      } catch {
        tags = [];
      }
      return {
        id: r.id,
        type: r.type,
        title: r.title || '',
        content: r.content || '',
        tags,
        tagTokens: tokenizeTags(tags),
        embedding: r.embedding,
        embeddingDim: r.embedding_dim,
        confidence: r.confidence,
        updatedAt: r.updated_at,
      };
    });
}

// Pair-level loader: every active memory (with or without an
// embedding). Title-dedup uses no embedding; near-dup uses embedding
// when present and skips silently otherwise. Same input cap as the
// clusterer so the O(N²) near-dup loop is bounded.
function loadActiveMemoriesForPairs(db, projectKey) {
  return db
    .prepare(
      `SELECT id, type, title, content, tags, embedding, embedding_dim, confidence, updated_at
       FROM memories
       WHERE project_key = ?
         AND status = 'active'
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(projectKey, CONSOLIDATE_INPUT_CAP)
    .map((r) => {
      let tags = [];
      try {
        tags = JSON.parse(r.tags || '[]');
      } catch {
        tags = [];
      }
      return {
        id: r.id,
        type: r.type,
        title: r.title || '',
        content: r.content || '',
        tags,
        tagTokens: tokenizeTags(tags),
        embedding: r.embedding,
        embeddingDim: r.embedding_dim,
        confidence: r.confidence,
        updatedAt: r.updated_at,
      };
    });
}

// Pre-existing conclusion child ids that already cover a candidate
// cluster. We use this to skip clusters that already have a synthesis
// in memory_synthesizes — the conclusion primitive is the canonical
// "these are related" signal, so a re-synthesis would be a duplicate.
//
// Returns a Set of memory ids that appear in any memory_synthesizes
// row for this project. Cheap one-row query; the table has an index
// on (parent_id, child_id).
function loadExistingConclusionChildren(db, projectKey) {
  const rows = db
    .prepare(`SELECT DISTINCT child_id FROM memory_synthesizes WHERE project_key = ?`)
    .all(projectKey);
  return new Set(rows.map((r) => r.child_id));
}

// Decode an embedding BLOB into a Float32Array. Reuses the canonical
// decoder from src/embedding.js which validates BLOB size and rejects
// NaN/Inf values — the previous local copy silently produced NaN-filled
// Float32Arrays on corrupt input, causing cosine to silently return 0.
// (Audit finding B4-7.)
import { decodeVector as decodeEmbedding } from './embedding.js';

// Cosine similarity between two Float32Arrays of equal length.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Greedy single-link clustering. Walks the candidate list, picks the
// highest-density seed, and grows a cluster around it. Returns an
// array of arrays of memory ids. No LLM, no network — pure cosine.
//
// This is intentionally simple. Density-based methods like DBSCAN are
// overkill for the working set sizes we target (≤200 memories per
// project). Single-link with a hard cap on cluster size avoids the
// "everything is one cluster" failure mode of pure transitive closure.
//
// Cost: the candidate list is bounded by CONSOLIDATE_INPUT_CAP (=640),
// so the O(N²) cosine loop is bounded. We pre-decode every embedding
// once before the loop — the previous shape re-decoded the same BLOB
// for every (i, j) pair, ~200k decodes for N=640 vs the 640 a single
// pass requires. (Audit fix.)
function clusterMemories(memories, { decodeEmbedding }) {
  const clusters = [];
  const visited = new Set();

  // Pre-decode each BLOB into a Float32Array once. Skips BLOBs that
  // decode to nothing (corrupt size, NaN/Inf) so the inner loops only
  // see valid vectors.
  const decoded = new Map();
  for (const m of memories) {
    const v = decodeEmbedding(m.embedding);
    if (v) decoded.set(m.id, v);
  }

  // Small-dataset escape: when the project carries fewer than
  // SMALL_DATASET_THRESHOLD active memories, the tag-overlap filter
  // drops to 0 so a 4–6 memory project can still cluster. The cosine
  // floor stays at CONSOLIDATE_THRESHOLD either way.
  const tagFloor = effectiveTagOverlap(memories.length);

  for (let i = 0; i < memories.length; i++) {
    if (visited.has(memories[i].id)) continue;
    if (clusters.length >= CONSOLIDATE_MAX_CLUSTERS) break;

    const seed = memories[i];
    const seedVec = decoded.get(seed.id);
    if (!seedVec) continue;

    // Single-link expand: every other memory that is cosine ≥
    // threshold AND shares ≥ tagFloor tags is a sibling.
    const cluster = [seed];
    visited.add(seed.id);
    for (let j = i + 1; j < memories.length; j++) {
      if (visited.has(memories[j].id)) continue;
      const other = memories[j];
      const otherVec = decoded.get(other.id);
      if (!otherVec) continue;
      if (cosine(seedVec, otherVec) < CONSOLIDATE_THRESHOLD) continue;
      if (tagOverlap(seed.tagTokens, other.tagTokens) < tagFloor) continue;
      cluster.push(other);
      visited.add(other.id);
      if (cluster.length >= CONSOLIDATE_MAX_MEMBERS) break;
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      clusters.push(cluster);
    }
  }
  return clusters;
}

// Build the conclusion body. Deterministic — child titles are joined
// in id-order (which is creation order on saveMemory) so a re-run
// produces the same body. The first non-empty content line of each
// child is included so the conclusion carries enough signal that the
// agent can act on it without recalling every child.
function buildConclusionBody(cluster) {
  const lines = ['Synthesised by background consolidation. Cluster of related memories:', ''];
  for (const m of cluster) {
    const title = m.title || '(untitled)';
    const first = (m.content || '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find((line) => line.length > 0);
    // (Audit fix BUG-12) — slice the snippet on a code-point boundary.
    const snippet = first
      ? ` — ${first.length > 100 ? sliceCodePointSafe(first, 100) + '…' : first}`
      : '';
    lines.push(`- ${title}${snippet}`);
  }
  return lines.join('\n');
}

// Slice a string on a code-point boundary so a surrogate pair is
// never split mid-emoji. Mirrors `search.js#truncate` and the helper
// in session-focus.js#sliceCodePointSafe. (Audit fix BUG-12.)
function sliceCodePointSafe(s, n) {
  if (!s || s.length <= n) return s;
  let cut = n;
  while (cut > 0 && (s.charCodeAt(cut - 1) & 0xfc00) === 0xdc00) cut -= 1;
  return s.slice(0, cut);
}

// Build the conclusion title. Length-capped so it stays under the
// title column's effective width (80 chars was the auto-extract
// convention; we keep the same).
function buildConclusionTitle(cluster) {
  const titles = cluster.map((m) => m.title || '(untitled)').slice(0, 3);
  const head = titles.join(' / ');
  return head.length > 80 ? `Synthesis: ${sliceCodePointSafe(head, 80)}…` : `Synthesis: ${head}`;
}

// Determine the union of tags from a cluster. Used as the conclusion
// memory's tags so future recall hits it naturally when the cluster
// would.
function unionTags(cluster) {
  const seen = new Set();
  const out = [];
  for (const m of cluster) {
    for (const t of m.tags || []) {
      const key = String(t).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// ============================================================
// Pair-level dedup paths (v15)
// ============================================================
//
// Two narrow triggers that catch the "I saved the same thing twice"
// case the clusterer misses:
//   - title-dedup: same normalised title in the project → merge pair
//   - near-dup cosine: cosine ≥ 0.92 AND a shared 10-word window
//
// Both paths emit `merge` proposals that flow through the existing
// dream pipeline (checksum-validated apply) and the existing direct
// mergeMemory path. Off via KIMI_MEMORY_DEDUP=off.

// KIMI_MEMORY_DEDUP=on (default) enables the pair-level paths. Off
// falls back to the clusterer-only behaviour.
function isDedupEnabled() {
  const v = process.env.KIMI_MEMORY_DEDUP;
  return v === undefined || v === 'on';
}

// Case-fold + collapse whitespace + strip trailing punctuation. The
// goal is "Build command: npm test" matching "build command: npm test."
// rather than "build-command-npm-test". Anything more aggressive risks
// merging memories that merely share a stock prefix.
function normaliseTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

// True iff two arrays share any contiguous sub-array of length ≥ `minLen`
// (joined by space). Used as the "near-duplicate content" signal for the
// near-dup cosine pass.
function arraysShareWindow(a, b, minLen) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length < minLen || b.length < minLen) return false;
  const setA = new Set();
  for (let i = 0; i + minLen <= a.length; i++) {
    setA.add(a.slice(i, i + minLen).join(' '));
  }
  for (let i = 0; i + minLen <= b.length; i++) {
    if (setA.has(b.slice(i, i + minLen).join(' '))) return true;
  }
  return false;
}

// Group memories by normalised title. For every group with ≥2 rows,
// pick the highest-confidence sibling as the target and emit one pair
// per other sibling. Idempotent within a run (a single memory can
// appear as the sibling in multiple pairs across different groups only
// when it has multiple distinct titles — extremely rare).
function findTitleDedupPairs(memories) {
  const groups = new Map();
  for (const m of memories) {
    const key = normaliseTitle(m.title || '');
    if (!key) continue; // skip untitled memories
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => {
      const ac = a.confidence || 0;
      const bc = b.confidence || 0;
      if (bc !== ac) return bc - ac;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    const target = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const sibling = sorted[i];
      if (sibling.id === target.id) continue;
      out.push({ target, sibling, trigger: 'title_dedup' });
    }
  }
  return out;
}

// Find pairs whose embeddings are cosine ≥ NEAR_DUP_COSINE AND whose
// contents share a 10-word window. Skips rows without a usable
// embedding (the title-dedup path catches those). Idempotent within a
// run via a (sorted ids) set.
function findNearDupPairs(memories, decodeEmbedding) {
  const NEAR_DUP_COSINE = 0.92;
  const NEAR_DUP_WINDOW = 10;
  const decoded = new Map();
  for (const m of memories) {
    const v = decodeEmbedding(m.embedding);
    if (v) decoded.set(m.id, v);
  }
  const out = [];
  const seenPairs = new Set();
  for (let i = 0; i < memories.length; i++) {
    const a = memories[i];
    const aVec = decoded.get(a.id);
    if (!aVec) continue;
    const aWords = (a.content || '').split(/\s+/).filter(Boolean);
    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j];
      const bVec = decoded.get(b.id);
      if (!bVec) continue;
      const sim = cosine(aVec, bVec);
      if (sim < NEAR_DUP_COSINE) continue;
      const bWords = (b.content || '').split(/\s+/).filter(Boolean);
      if (!arraysShareWindow(aWords, bWords, NEAR_DUP_WINDOW)) continue;
      // Target = higher-confidence sibling.
      const ac = a.confidence || 0;
      const bc = b.confidence || 0;
      const target =
        bc > ac
          ? b
          : ac > bc
            ? a
            : (a.updatedAt || '').localeCompare(b.updatedAt || '') > 0
              ? a
              : b;
      const sibling = target === a ? b : a;
      const key = [a.id, b.id].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      out.push({ target, sibling, trigger: 'near_dup', cosine: sim });
    }
  }
  return out;
}

// Stable checksum for a pair. Mirrors the cluster checksum shape
// (`id@updated_at`) so the apply step's re-derivation lands on the
// same value when neither side drifted.
function pairChecksum(a, b) {
  const parts = [`${a.id}@${a.updatedAt || ''}`, `${b.id}@${b.updatedAt || ''}`];
  return parts.sort().join('|');
}

// ============================================================
// consolidation_runs writer (v15)
// ============================================================
//
// One row per pass outcome. Lets memory_status surface "when did
// consolidation last run and what happened" without re-walking the
// memories table. The apply step in src/dream.js calls this too so
// last_dream_apply_at and last_consolidate_at share the same source.
//
// Best-effort: write errors are swallowed so a logging failure never
// blocks the actual consolidation write.
export function recordConsolidationRun(db, projectKey, result, { trigger = 'inline' } = {}) {
  if (!db || !projectKey) return { ok: false, reason: 'no_inputs' };
  try {
    const summary = {
      trigger,
      scanned: result.scanned || 0,
      clusters: result.clusters || 0,
      saved: result.saved || 0,
      skipped: result.skipped || 0,
      errors: result.errors || 0,
      merged: result.merged || 0,
      mergeSkipped: result.mergeSkipped || 0,
      proposals: Array.isArray(result.proposals) ? result.proposals.length : 0,
      dedup_pairs: result.dedup_pairs || 0,
      dedup_title_pairs: result.dedup_title_pairs || 0,
      dedup_near_dup_pairs: result.dedup_near_dup_pairs || 0,
      embedding_missing: result.embedding_missing || 0,
    };
    const id = shortId(hashId('crun', projectKey, nowIso(), String(Math.random())), 16);
    db.prepare(
      `INSERT INTO consolidation_runs (id, project_key, summary, at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, projectKey, JSON.stringify(summary), nowIso());
    return { ok: true, id };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

// Build a `merge` proposal for a pair. The proposed content is the
// target's body — the sibling is soft-superseded so recall still hits
// the surviving row with the same body.
function buildPairMergeProposal({ target, sibling, trigger, cosine }) {
  const baseConf = trigger === 'title_dedup' ? 0.9 : 0.85;
  const provenance = {
    source: 'consolidation_pass',
    cluster_size: 2,
    recorded_at: nowIso(),
    proposed_kind: 'pair_merge',
    trigger,
  };
  if (typeof cosine === 'number') provenance.cosine = cosine;
  return {
    kind: 'merge',
    source_ids: [target.id, sibling.id],
    target_ids: [target.id],
    proposed_content: target.content || '',
    proposed_title: target.title || '',
    proposed_tags: Array.isArray(target.tags) ? target.tags : [],
    confidence: baseConf,
    provenance,
    source_checksum: pairChecksum(target, sibling),
  };
}

// Top-level: walk clusters, write one conclusion per cluster.
//
// Caller passes saveMemory and memoryLink as injected dependencies so
// this module is testable without a real DB. The defaults below match
// the real persist-layer entry points.
//
//   saveMemory(db, projectKey, input)
//   memoryLink(db, projectKey, fromId, toId, 'synthesizes', { weight })
//
// Two modes:
//   - direct (default): write conclusions + soft-merge tight clusters
//     into the live memories table. Used by SessionStart / direct
//     tests. Behaviour identical to the pre-dream implementation.
//   - proposal: walk the same clusters and emit a list of proposed
//     operations (conclusion, merge, link) without mutating the live
//     store. Used by the Phase-1 dream pipeline (src/dream.js) so a
//     separate apply step can validate inputs and commit. Returning
//     proposals is a pure function over the snapshot; it never
//     touches the DB.
export async function runConsolidate({
  db,
  projectKey,
  saveMemory,
  memoryLink,
  mergeMemory,
  isDisabled = () => process.env.KIMI_MEMORY_CONSOLIDATE === 'off',
  decodeEmbeddingImpl = decodeEmbedding,
  // 'proposal' returns the same shape as direct mode but the caller
  // gets a `proposals` array and the live memories table is
  // untouched. Anything else falls back to the legacy direct path.
  mode = 'direct',
}) {
  const result = {
    scanned: 0,
    clusters: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
    merged: 0,
    mergeSkipped: 0,
    proposals: [],
    // Pair-level dedup pass counts (v15). Plumbed through runConsolidate
    // so the hook status line + memory_status can surface how many
    // duplicates were caught without surfacing per-row details.
    dedup_pairs: 0,
    dedup_title_pairs: 0,
    dedup_near_dup_pairs: 0,
    // Embedding coverage diagnostics (B7). Tells the user "you have N
    // active memories that the clusterer can't touch because no
    // embedding" instead of a silent `clusters=0`.
    embedding_missing: 0,
  };
  if (isDisabled()) {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (!db || !projectKey) {
    result.skipped = 'no_inputs';
    return result;
  }

  // Auto-merge defaults: ON. Off only via the explicit env opt-out.
  // The merge step is non-destructive (soft-supersede) so a wrong
  // cluster can be un-merged by walking the merged_from provenance.
  const autoMergeEnabled =
    process.env.KIMI_MEMORY_AUTO_MERGE !== 'off' && typeof mergeMemory === 'function';

  let memories;
  try {
    memories = loadActiveMemories(db, projectKey);
  } catch (e) {
    recordConsolidationRun(db, projectKey, result, { trigger: 'inline' });
    return { ...result, error: e && e.message ? e.message : String(e) };
  }
  result.scanned = memories.length;

  // Embedding-coverage diagnostic (B7): how many active memories have
  // no embedding at all? Computed BEFORE the early-return so a 0-row
  // clusterable set still surfaces this — otherwise a fresh project
  // with no embeddings reports a silent `clusters=0` with no clue.
  try {
    result.embedding_missing = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE project_key = ?
           AND status = 'active'
           AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
           AND (embedding IS NULL OR embedding_dim IS NULL)`,
      )
      .get(projectKey).n;
  } catch {
    result.embedding_missing = 0;
  }

  // ---- v15 Pair-level dedup pass ----
  //
  // Runs BEFORE the cluster path's MIN_CLUSTER_SIZE short-circuit so
  // 2-memory projects still get duplicates merged. The pair pass has
  // its own `length >= 2` guard so a fresh install (0 active rows)
  // returns silently. Title-dedup catches exact-title duplicates
  // without an embedding; near-dup cosine requires embeddings.
  if (isDedupEnabled()) {
    let pairRows;
    try {
      pairRows = loadActiveMemoriesForPairs(db, projectKey);
    } catch {
      pairRows = [];
    }
    if (pairRows.length >= 2) {
      let covered;
      try {
        covered = loadExistingConclusionChildren(db, projectKey);
      } catch {
        covered = new Set();
      }
      const titlePairs = findTitleDedupPairs(pairRows);
      let nearDupPairs = [];
      try {
        nearDupPairs = findNearDupPairs(pairRows, decodeEmbeddingImpl);
      } catch {
        nearDupPairs = [];
      }
      const emittedPairKeys = new Set();
      const allPairs = [...titlePairs, ...nearDupPairs];
      for (const pair of allPairs) {
        if (covered.has(pair.target.id) || covered.has(pair.sibling.id)) continue;
        const key = [pair.target.id, pair.sibling.id].sort().join('|');
        if (emittedPairKeys.has(key)) continue;
        emittedPairKeys.add(key);
        result.dedup_pairs += 1;
        if (pair.trigger === 'title_dedup') result.dedup_title_pairs += 1;
        else result.dedup_near_dup_pairs += 1;
        const proposal = buildPairMergeProposal(pair);
        if (mode === 'proposal') {
          result.proposals.push(proposal);
        } else if (typeof mergeMemory === 'function') {
          try {
            mergeMemory(db, projectKey, pair.target.id, pair.sibling.id, {
              mergedContent: proposal.proposed_content,
              weight: 1.0,
            });
            result.merged += 1;
          } catch {
            result.mergeSkipped += 1;
          }
        }
        covered.add(pair.target.id);
        covered.add(pair.sibling.id);
      }
    }
  }

  // Below this point the original cluster path runs. By this time
  // `result.dedup_pairs` already reflects any pair-level work.
  if (memories.length < MIN_CLUSTER_SIZE) {
    result.skipped = 'below_threshold';
    recordConsolidationRun(db, projectKey, result, { trigger: 'inline' });
    return result;
  }

  let clusters;
  try {
    clusters = clusterMemories(memories, { decodeEmbedding: decodeEmbeddingImpl });
  } catch (e) {
    recordConsolidationRun(db, projectKey, result, { trigger: 'inline' });
    return { ...result, error: e && e.message ? e.message : String(e) };
  }
  result.clusters = clusters.length;

  let covered;
  try {
    covered = loadExistingConclusionChildren(db, projectKey);
  } catch {
    covered = new Set();
  }

  for (const cluster of clusters) {
    // Idempotency: if ≥75% of the cluster already appears as a child
    // of any existing conclusion, the cluster is already synthesised.
    let hits = 0;
    for (const m of cluster) if (covered.has(m.id)) hits += 1;
    if (hits / cluster.length >= COVERAGE_RATIO) {
      result.skipped += 1;
      continue;
    }

    const title = buildConclusionTitle(cluster);
    const content = buildConclusionBody(cluster);
    const tags = ['consolidation', 'auto', ...unionTags(cluster).slice(0, 6)];
    const provenance = {
      source: 'consolidation_pass',
      child_ids: cluster.map((m) => m.id),
      cluster_size: cluster.length,
      recorded_at: nowIso(),
    };

    // Proposal mode: emit the conclusion + edge proposals into the
    // collector and continue. The live memories table is untouched;
    // apply is a separate transaction in src/dream.js.
    if (mode === 'proposal') {
      // source_checksum binds the proposal to the snapshot it was
      // generated against; apply re-derives it and marks the proposal
      // stale when any source row drifted.
      const checksum = sourceChecksum(cluster);
      result.proposals.push({
        kind: 'conclusion',
        source_ids: cluster.map((m) => m.id),
        target_ids: [],
        proposed_content: content,
        proposed_title: title,
        proposed_tags: tags,
        confidence: 0.7,
        provenance: { ...provenance, proposed_kind: 'conclusion' },
        source_checksum: checksum,
      });
      // One link proposal per child → conclusion so the apply step
      // can install typed `synthesizes` edges without re-walking the
      // cluster. The target id is the conclusion id we just proposed;
      // the apply step substitutes the persisted id after the
      // conclusion insert.
      for (const child of cluster) {
        result.proposals.push({
          kind: 'link',
          source_ids: [child.id],
          target_ids: [],
          proposed_content: '',
          proposed_title: '',
          proposed_tags: [],
          confidence: 0.7,
          provenance: { ...provenance, proposed_kind: 'synthesizes_link' },
          source_checksum: checksum,
        });
      }
      // Tight clusters also propose merges. The merge target is the
      // highest-confidence sibling; siblings are listed in source_ids.
      if (autoMergeEnabled && cluster.length >= AUTO_MERGE_THRESHOLDS.clusterSize) {
        const isTight = isClusterTight(cluster, decodeEmbeddingImpl);
        if (isTight) {
          const target = pickMergeTarget(cluster);
          const siblings = cluster.filter((m) => m.id !== target.id);
          if (siblings.length > 0) {
            result.proposals.push({
              kind: 'merge',
              source_ids: [target.id, ...siblings.map((m) => m.id)],
              target_ids: [target.id],
              proposed_content: content,
              proposed_title: '',
              proposed_tags: [],
              confidence: 0.85,
              provenance: { ...provenance, proposed_kind: 'merge', merge_target: target.id },
              source_checksum: checksum,
            });
          }
        }
      }
      result.saved += 1;
      for (const m of cluster) covered.add(m.id);
      continue;
    }

    // Direct mode (legacy behaviour). saveMemory / memoryLink /
    // mergeMemory are required; if any are missing we skip rather than
    // crash (preserves the documented contract).
    if (!saveMemory || !memoryLink) {
      result.skipped = 'no_persist';
      recordConsolidationRun(db, projectKey, result, { trigger: 'inline' });
      return result;
    }

    let saved;
    try {
      saved = saveMemory(db, projectKey, {
        type: 'conclusion',
        title,
        content,
        tags,
        confidence: 0.7,
        priority: 0,
        provenance,
        synthesizes: cluster.map((m) => m.id),
        _embed: false,
      });
    } catch (e) {
      result.errors += 1;
      continue;
    }
    if (!saved || !saved.id) {
      result.errors += 1;
      continue;
    }

    // Record typed edges (one per child → parent) so the conclusion
    // shows up in memory_edges traversals as well as memory_synthesizes.
    // The UNIQUE constraint on (project_key, from_id, to_id, kind)
    // makes this safe under a re-run.
    for (const child of cluster) {
      try {
        memoryLink(db, projectKey, child.id, saved.id, 'synthesizes', { weight: 1.0 });
      } catch {
        /* edge insert may collide with existing row; ignore */
      }
    }

    result.saved += 1;
    // Mark cluster members as covered so a subsequent cluster that
    // shares a member does not double-synthesise.
    for (const m of cluster) covered.add(m.id);

    // Auto-merge: tight clusters (cosine ≥ AUTO_MERGE_THRESHOLDS.cosine
    // AND tag overlap ≥ AUTO_MERGE_THRESHOLDS.tagOverlap) get their
    // siblings collapsed into the highest-confidence member. The
    // merged target's content is replaced by the conclusion body, so
    // a recall hit shows the synthesis rather than the redundant
    // siblings. Siblings are soft-superseded (status='superseded',
    // superseded_by=target) — never hard-deleted — so the operator
    // can un-merge by inspecting the merged_from provenance chain.
    //
    // Skipped when:
    //   - auto-merge is disabled (env var)
    //   - mergeMemory was not injected (test path)
    //   - the cluster is not tight enough
    //   - the cluster has fewer than AUTO_MERGE_THRESHOLDS.clusterSize
    if (autoMergeEnabled && cluster.length >= AUTO_MERGE_THRESHOLDS.clusterSize) {
      let isTight = true;
      const tightVec = decodeEmbeddingImpl(cluster[0].embedding);
      if (!tightVec) {
        isTight = false;
      } else {
        // Reuse the pre-decoded vectors where possible. The first
        // sibling's blob is decoded here (the cluster loop above
        // discards them); siblings 1..N reach for the freshly-decoded
        // vector first and fall back to a single decode if the
        // earlier pass skipped it (corrupt BLOB).
        const tight = cluster[0];
        for (let i = 1; i < cluster.length; i++) {
          const sibling = cluster[i];
          const otherVec =
            (tight.embedding === sibling.embedding && tight.embedding ? tightVec : null) ||
            decodeEmbeddingImpl(sibling.embedding);
          if (!otherVec) {
            isTight = false;
            break;
          }
          if (cosine(tightVec, otherVec) < AUTO_MERGE_THRESHOLDS.cosine) {
            isTight = false;
            break;
          }
          if (
            tagOverlap(cluster[0].tagTokens, cluster[i].tagTokens) <
            AUTO_MERGE_THRESHOLDS.tagOverlap
          ) {
            isTight = false;
            break;
          }
        }
      }
      if (isTight) {
        // Pick the highest-confidence sibling as the merge target.
        // Ties broken by updated_at DESC (most recent wins).
        const target = cluster.reduce((best, m) => {
          const bestConf = best.confidence || 0;
          const mConf = m.confidence || 0;
          return mConf > bestConf ? m : best;
        });
        // Chain the others into the target. mergeMemory is
        // (a, b) -> {a updated, b superseded}; we loop until every
        // sibling is folded in.
        for (const sibling of cluster) {
          if (sibling.id === target.id) continue;
          try {
            mergeMemory(db, projectKey, target.id, sibling.id, {
              mergedContent: content,
              weight: 1.0,
            });
            result.merged += 1;
          } catch (e) {
            // Merge failure: the conclusion is still saved, so the
            // cluster is at least summarised. The next pass will pick
            // up the (still-active) siblings.
            result.mergeSkipped += 1;
          }
        }
      } else {
        result.mergeSkipped += 1;
      }
    } else {
      result.mergeSkipped += 1;
    }
  }

  // v15: write a consolidation_runs row so memory_status + the hook
  // status line can answer "when did this last run" without a SELECT
  // scan. Best-effort; the helper swallows its own write errors.
  recordConsolidationRun(db, projectKey, result, { trigger: 'inline' });

  return result;
}

// Pick the highest-confidence sibling as the merge target. Ties broken
// by updated_at DESC (most recent wins). Mirrors the direct-mode logic
// above so proposal mode and direct mode pick the same target.
function pickMergeTarget(cluster) {
  return cluster.reduce((best, m) => {
    const bestConf = best.confidence || 0;
    const mConf = m.confidence || 0;
    if (mConf > bestConf) return m;
    if (mConf === bestConf && (m.updatedAt || '') > (best.updatedAt || '')) return m;
    return best;
  });
}

// Re-test a cluster against the auto-merge tightness thresholds. Same
// math as the direct-mode branch above; isolated here so proposal mode
// does not duplicate the cosine / tag-overlap loops.
function isClusterTight(cluster, decodeEmbeddingImpl) {
  if (!decodeEmbeddingImpl) return false;
  const tightVec = decodeEmbeddingImpl(cluster[0].embedding);
  if (!tightVec) return false;
  const tight = cluster[0];
  for (let i = 1; i < cluster.length; i++) {
    const sibling = cluster[i];
    const otherVec =
      (tight.embedding === sibling.embedding && tight.embedding ? tightVec : null) ||
      decodeEmbeddingImpl(sibling.embedding);
    if (!otherVec) return false;
    if (cosine(tightVec, otherVec) < AUTO_MERGE_THRESHOLDS.cosine) return false;
    if (tagOverlap(cluster[0].tagTokens, cluster[i].tagTokens) < AUTO_MERGE_THRESHOLDS.tagOverlap)
      return false;
  }
  return true;
}

// Stable checksum over the (id, updated_at) pairs of a cluster. The
// apply step re-derives this; a mismatch means one of the source rows
// drifted and the proposal is stale.
function sourceChecksum(cluster) {
  const parts = cluster
    .map((m) => `${m.id}@${m.updatedAt || ''}`)
    .sort()
    .join('|');
  return parts;
}

// Exported so src/dream.js#applyJob can validate a proposal against
// the live rows before applying.
export function proposalSourceChecksum(cluster) {
  return sourceChecksum(cluster);
}

// Re-export the thresholds + caps so the dream layer can describe
// proposals without re-deriving them. Mirrors the live direct-mode
// shape — a change here is a change to both modes.
export const CONSOLIDATE_BOUNDS = {
  inputCap: CONSOLIDATE_INPUT_CAP,
  maxClusters: CONSOLIDATE_MAX_CLUSTERS,
  maxMembers: CONSOLIDATE_MAX_MEMBERS,
  minClusterSize: MIN_CLUSTER_SIZE,
  cosineThreshold: CONSOLIDATE_THRESHOLD,
  minTagOverlap: MIN_TAG_OVERLAP,
  coverageRatio: COVERAGE_RATIO,
  smallDatasetThreshold: SMALL_DATASET_THRESHOLD,
};

// Exported so tests + the status line can describe the current
// effective tag-overlap floor without re-deriving it.
export { isRelaxEnabled, effectiveTagOverlap };
