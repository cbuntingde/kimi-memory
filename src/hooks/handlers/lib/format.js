// Pure status-line segment formatters for hook handlers.
//
// Each formatter takes the JSON-shaped counts object produced by
// `pipeline.js` builders and returns a short human-readable string
// (or 'none') for the bounded status line. No DB access, no side
// effects — these can be tested without any fixtures.

export function formatConsolidateSegment(consolidate) {
  if (!consolidate) return 'none';
  if (consolidate.error) return `err:${consolidate.error}`;
  // Pair-level dedup (v15). When present, lead with the pair count so
  // the user sees duplicates being caught even on small datasets that
  // never form a cluster.
  const pairs = consolidate.dedup_pairs || 0;
  if (pairs > 0) {
    const title = consolidate.dedup_title_pairs || 0;
    const nearDup = consolidate.dedup_near_dup_pairs || 0;
    const saved = consolidate.saved || 0;
    const merged = consolidate.merged || 0;
    return `pairs:${pairs}=title:${title}+near:${nearDup} clusters:${saved} merges:${merged}`;
  }
  if (consolidate.saved && consolidate.saved > 0) {
    const merged = consolidate.merged ? `+merges:${consolidate.merged}` : '';
    return `clusters:${consolidate.saved} merges:${consolidate.merged || 0}${merged}`;
  }
  if (consolidate.clusters && consolidate.clusters > 0) {
    return `kept:0/of:${consolidate.clusters}`;
  }
  // Quiet runs: tell the user WHY so they don't think consolidation is
  // broken. Embedding-missing is the dominant silent-zero cause on a
  // fresh project.
  if (consolidate.embedding_missing && consolidate.embedding_missing > 0) {
    return `embed_missing:${consolidate.embedding_missing}`;
  }
  if (consolidate.skipped) return `skip:${consolidate.skipped}`;
  return 'none';
}

export function formatAutoGcSegment(autoGc) {
  if (!autoGc) return 'none';
  if (autoGc.error) return `err:${autoGc.error}`;
  const prune = autoGc.prune || {};
  const archive = autoGc.archive || {};
  const tier = autoGc.tier || {};
  const pruned =
    (prune.pruned_deleted || 0) +
    (prune.pruned_superseded || 0) +
    (prune.pruned_embed_failed || 0) +
    (prune.pruned_cold || 0) +
    (prune.pruned_orphans || 0);
  const archived =
    (archive.archived_conversation_events || 0) +
    (archive.archived_skill_invocations || 0) +
    (archive.archived_persona_promotions || 0);
  const promoted =
    (tier.promoted_l0_to_l1 || 0) + (tier.promoted_l1_to_l2 || 0) + (tier.promoted_l2_to_l3 || 0);
  const demoted = tier.demoted_to_l0 || 0;
  if (prune.skipped === 'throttled' && archive.skipped === 'throttled') {
    return `tier:prom:${promoted}/dem:${demoted}/heavy:throttled`;
  }
  if (pruned === 0 && archived === 0 && promoted === 0 && demoted === 0) {
    return 'none';
  }
  return `prune:${pruned}/archive:${archived}/tier:prom:${promoted}/dem:${demoted}`;
}

export function formatIngestSegment(ingest) {
  if (!ingest) return 'none';
  if (ingest.ingested && ingest.ingested > 0) return `ok:${ingest.ingested}`;
  if (ingest.skipped) return `skip:${ingest.skipped}`;
  if (ingest.archive_not_found) return `skip:archive_not_found`;
  if (ingest.ok) return 'ok:0';
  return 'skipped';
}

export function formatDreamSegment(status) {
  if (!status) return 'none';
  return status.label || 'none';
}

export function formatExtractSegment(extract) {
  if (!extract) return 'none';
  if (extract.saved && extract.saved > 0)
    return `saved:${extract.saved}/dup:${extract.duplicates || 0}${
      extract.secrets_dropped ? `/sec:${extract.secrets_dropped}` : ''
    }`;
  if (extract.extracted && extract.extracted > 0)
    return `kept:0/dup:${extract.duplicates || 0}/of:${extract.extracted}`;
  if (extract.skipped) return `skip:${extract.skipped}`;
  if (extract.error) return `err:${extract.error}`;
  return 'none';
}

export function formatWorkLogSegment(wl) {
  if (!wl) return 'none';
  if (wl.written && wl.written > 0) {
    return wl.updated ? 'updated' : 'saved';
  }
  if (wl.skipped) return `skip:${wl.skipped}`;
  return 'none';
}
