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

import { nowIso } from './util.js';
import { AUTO_MERGE_THRESHOLDS } from './auto-gc.js';

const CONSOLIDATE_THRESHOLD = 0.75; // cosine floor for "related enough"
const MIN_TAG_OVERLAP = 2; // at least this many shared tags
const MIN_CLUSTER_SIZE = 3; // need >=3 siblings to synthesise
const CONSOLIDATE_MAX_MEMBERS = 8; // cap cluster size to keep conclusion bodies readable
const CONSOLIDATE_MAX_CLUSTERS = 20; // cap clusters per pass
const COVERAGE_RATIO = 0.75; // an existing conclusion "covers" a cluster if >=75% of the cluster is already linked

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
function clusterMemories(memories, { decodeEmbedding }) {
  const clusters = [];
  const visited = new Set();

  for (let i = 0; i < memories.length; i++) {
    if (visited.has(memories[i].id)) continue;
    if (clusters.length >= CONSOLIDATE_MAX_CLUSTERS) break;

    const seed = memories[i];
    const seedVec = decodeEmbedding(seed.embedding);
    if (!seedVec) continue;

    // Single-link expand: every other memory that is cosine ≥
    // threshold AND shares ≥ MIN_TAG_OVERLAP tags is a sibling.
    const cluster = [seed];
    visited.add(seed.id);
    for (let j = i + 1; j < memories.length; j++) {
      if (visited.has(memories[j].id)) continue;
      const other = memories[j];
      const otherVec = decodeEmbedding(other.embedding);
      if (!otherVec) continue;
      if (cosine(seedVec, otherVec) < CONSOLIDATE_THRESHOLD) continue;
      if (tagOverlap(seed.tagTokens, other.tagTokens) < MIN_TAG_OVERLAP) continue;
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
    const snippet = first ? ` — ${first.length > 100 ? first.slice(0, 100) + '…' : first}` : '';
    lines.push(`- ${title}${snippet}`);
  }
  return lines.join('\n');
}

// Build the conclusion title. Length-capped so it stays under the
// title column's effective width (80 chars was the auto-extract
// convention; we keep the same).
function buildConclusionTitle(cluster) {
  const titles = cluster.map((m) => m.title || '(untitled)').slice(0, 3);
  const head = titles.join(' / ');
  return head.length > 80 ? head.slice(0, 80) + '…' : `Synthesis: ${head}`;
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

// Top-level: walk clusters, write one conclusion per cluster.
//
// Caller passes saveMemory and memoryLink as injected dependencies so
// this module is testable without a real DB. The defaults below match
// the real persist-layer entry points.
//
//   saveMemory(db, projectKey, input)
//   memoryLink(db, projectKey, fromId, toId, 'synthesizes', { weight })
export async function runConsolidate({
  db,
  projectKey,
  saveMemory,
  memoryLink,
  mergeMemory,
  isDisabled = () => process.env.KIMI_MEMORY_CONSOLIDATE === 'off',
  decodeEmbeddingImpl = decodeEmbedding,
}) {
  const result = {
    scanned: 0,
    clusters: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
    merged: 0,
    mergeSkipped: 0,
  };
  if (isDisabled()) {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (!db || !projectKey) {
    result.skipped = 'no_inputs';
    return result;
  }
  if (!saveMemory || !memoryLink) {
    result.skipped = 'no_persist';
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
    return { ...result, error: e && e.message ? e.message : String(e) };
  }
  result.scanned = memories.length;
  if (memories.length < MIN_CLUSTER_SIZE) {
    result.skipped = 'below_threshold';
    return result;
  }

  let clusters;
  try {
    clusters = clusterMemories(memories, { decodeEmbedding: decodeEmbeddingImpl });
  } catch (e) {
    return { ...result, error: e && e.message ? e.message : String(e) };
  }
  result.clusters = clusters.length;
  if (clusters.length === 0) return result;

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

    let saved;
    try {
      saved = saveMemory(db, projectKey, {
        type: 'conclusion',
        title,
        content,
        tags,
        confidence: 0.7,
        priority: 0,
        provenance: {
          source: 'consolidation_pass',
          child_ids: cluster.map((m) => m.id),
          cluster_size: cluster.length,
          recorded_at: nowIso(),
        },
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
        for (let i = 1; i < cluster.length; i++) {
          const otherVec = decodeEmbeddingImpl(cluster[i].embedding);
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

  return result;
}
