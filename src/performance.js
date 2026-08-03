// Performance optimization utilities for kimi-memory.
// Manages database indexes, query optimization, and batch operations.

// Additional indexes to improve query performance.
// These are idempotent: CREATE INDEX IF NOT EXISTS is safe to run repeatedly.
export const PERFORMANCE_INDEXES_SQL = `
  -- Index for time-range queries (e.g., "find all memories from last week").
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(project_key, created_at DESC);
  
  -- Index for importance-based queries (e.g., "list by confidence").
  CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(project_key, confidence DESC, status);
  
  -- Index for priority-based listing (e.g., "show high-priority items first").
  CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(project_key, priority DESC);
  
  -- Index for type+status combinations (common filter pattern).
  CREATE INDEX IF NOT EXISTS idx_memories_type_status ON memories(project_key, type, status);
  
  -- Index for active memories only (common read path).
  CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(project_key, status) WHERE status = 'active';
  
  -- Edges: index incoming edges (for memory_parents queries).
  CREATE INDEX IF NOT EXISTS idx_memory_edges_to_kind ON memory_edges(project_key, to_id, kind);
  
  -- Conversation events: timestamp index for time-range queries.
  CREATE INDEX IF NOT EXISTS idx_conversation_events_created ON conversation_events(project_key, session_id, created_at);
  
  -- Project paths: index for prune lookups.
  CREATE INDEX IF NOT EXISTS idx_project_paths_canonical ON project_paths(canonical_root);
`;

// Ensureindexes exist (idempotent).
export function ensurePerformanceIndexes(db) {
  try {
    db.exec(PERFORMANCE_INDEXES_SQL);
  } catch (err) {
    // Ignore: if indexes exist, this is a no-op. If they fail for other reasons, queries will still work.
  }
}

// Vacuum database to reclaim space from deletes.
export function vacuumDb(db) {
  try {
    db.exec('VACUUM');
    return true;
  } catch {
    return false;
  }
}

// Analyze database statistics (helps query planner).
export function analyzeDb(db) {
  try {
    db.exec('ANALYZE');
    return true;
  } catch {
    return false;
  }
}

// Get database stats for diagnostics.
export function getDbStats(db) {
  try {
    const pages = db.prepare("PRAGMA page_count").get();
    const pageSize = db.prepare("PRAGMA page_size").get();
    const freePages = db.prepare("PRAGMA freelist_count").get();

    return {
      page_count: pages.page_count,
      page_size: pageSize.page_size,
      free_pages: freePages.freelist_count,
      used_pages: pages.page_count - freePages.freelist_count,
      size_bytes: pages.page_count * pageSize.page_size,
      fragmentation_percent: Math.round(
        (freePages.freelist_count / pages.page_count) * 100 * 100
      ) / 100,
    };
  } catch {
    return null;
  }
}

// Batch embedding strategy: encode all vectors in a single operation.
// Returns [ {id, embedding}, ... ] after encoding all texts.
export async function batchEmbed(texts, embedFn, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  
  const batchSize = options.batchSize || 50;
  const results = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const encoded = await Promise.all(
      batch.map(async (text) => {
        try {
          const vec = await embedFn(text);
          return vec ? { text, embedding: vec } : { text, embedding: null };
        } catch {
          return { text, embedding: null };
        }
      })
    );
    results.push(...encoded);
  }
  
  return results;
}

// Query optimization advice.
export function getQueryOptimizationAdvice(queryType, rowCount) {
  const advice = [];
  
  if (rowCount > 100000 && queryType === 'full_scan') {
    advice.push('Large dataset: consider adding indexes or narrowing the query scope.');
  }
  
  if (queryType === 'search' && rowCount > 10000) {
    advice.push('FTS5 query on large dataset: ensure indexes on project_key + type.');
  }
  
  if (queryType === 'similarity' && rowCount > 1000) {
    advice.push('Similarity search: limit to a reasonable threshold (0.5+) or smaller result set.');
  }
  
  return advice;
}

// Connection pool statistics (for multi-process scenarios).
export function getConnectionStats(cachedDbs) {
  if (!cachedDbs) return null;
  
  const stats = {
    open_connections: cachedDbs.size,
    connections: [],
  };
  
  for (const [path, db] of cachedDbs) {
    stats.connections.push({
      path,
      open: true, // If it's in the cache, it's open
    });
  }
  
  return stats;
}

// Recommendation engine: suggest actions based on database state.
export function getMaintenanceRecommendations(stats) {
  const recommendations = [];
  
  if (!stats) return recommendations;
  
  if (stats.fragmentation_percent > 20) {
    recommendations.push({
      action: 'VACUUM',
      reason: `Database fragmentation is ${stats.fragmentation_percent}%`,
      priority: 'medium',
    });
  }
  
  if (stats.free_pages > stats.page_count * 0.3) {
    recommendations.push({
      action: 'VACUUM',
      reason: 'Over 30% of pages are free',
      priority: 'low',
    });
  }
  
  if (stats.page_count > 10000) {
    recommendations.push({
      action: 'ANALYZE',
      reason: 'Large database: run ANALYZE for better query planning',
      priority: 'low',
    });
  }
  
  return recommendations;
}
