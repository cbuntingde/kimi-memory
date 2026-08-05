// Data lifecycle management for kimi-memory.
// Handles archival, expiration, and cleanup of old data.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

const ARCHIVE_DAYS_DEFAULT = 30; // Archive conversations older than this
const PURGE_DAYS_DEFAULT = 90; // Delete archived data older than this

// Calculate which conversations should be archived based on age.
export function getConversationsToArchive(conversations, daysCutoff = ARCHIVE_DAYS_DEFAULT) {
  const cutoffMs = daysCutoff * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return conversations.filter((conv) => {
    const createdAt = new Date(conv.created_at || conv.first_event_at || 0).getTime();
    return now - createdAt > cutoffMs;
  });
}

// Calculate which memories should be pruned based on expiration and age.
export function getMemoriesToPrune(memories, daysCutoff = PURGE_DAYS_DEFAULT) {
  const cutoffMs = daysCutoff * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidates = [];

  for (const mem of memories) {
    // Check if expired.
    if (mem.expires_at) {
      const expiresAt = new Date(mem.expires_at).getTime();
      if (now >= expiresAt) {
        candidates.push({ id: mem.id, reason: 'expired', age_days: null });
        continue;
      }
    }

    // Check if soft-deleted and old.
    if (mem.status === 'deleted' || mem.status === 'superseded') {
      const updatedAt = new Date(mem.updated_at || 0).getTime();
      const ageDays = (now - updatedAt) / (24 * 60 * 60 * 1000);
      if (ageDays > daysCutoff) {
        candidates.push({ id: mem.id, reason: mem.status, age_days: Math.round(ageDays) });
      }
    }
  }

  return candidates;
}

// Archive configuration helper.
export function getArchiveConfig(overrides = {}) {
  return {
    archive_conversations_after_days:
      overrides.archive_conversations_after_days || ARCHIVE_DAYS_DEFAULT,
    purge_superseded_after_days: overrides.purge_superseded_after_days || PURGE_DAYS_DEFAULT,
    purge_deleted_after_days: overrides.purge_deleted_after_days || PURGE_DAYS_DEFAULT,
    archive_format: overrides.archive_format || 'json', // json, jsonl, or sqlite
    compress: overrides.compress !== false, // gzip by default
  };
}

// Build archival path for a conversation or batch.
export function getArchivePath(kimiHome, projectKey, identifier, archiveDate = null) {
  const date = archiveDate ? archiveDate.split('T')[0] : nowIso().split('T')[0];
  return path.join(kimiHome, 'kimi-memory', '_archives', projectKey, date, `${identifier}.json.gz`);
}

// Lifecycle policy for a database.
export function getLifecyclePolicy() {
  return {
    // Conversations: archive after inactivity, then delete after archive age.
    conversations: {
      archive_after_days: ARCHIVE_DAYS_DEFAULT,
      purge_archive_after_days: 365, // 1 year
      auto_archive: true,
    },
    // Memories: soft-delete superseded, hard-delete after age.
    memories: {
      soft_delete_superseded: true,
      purge_soft_deleted_after_days: PURGE_DAYS_DEFAULT,
      purge_expired_immediately: true,
      retention_grace_period_days: 30, // Grace period for accidental deletes
    },
    // Embeddings: drop when memory is deleted.
    embeddings: {
      drop_on_memory_delete: true,
    },
    // Working memory: clear after session end.
    working_memory: {
      clear_on_session_end: true,
      ttl_days: 7, // Clear unused slots after this
    },
  };
}

// Estimate database size in bytes.
export function estimateDbSize(memoriesCount, embeddingCount) {
  const memoryRowSize = 1024; // ~1KB per memory row (metadata, tags, provenance)
  const embeddingSize = 384 * 4; // 384-dim float32 = 1536 bytes per embedding
  const indexSize = (memoriesCount * 50) / 1000; // ~50 bytes per row in indexes

  return {
    memories: memoriesCount * memoryRowSize,
    embeddings: embeddingCount * embeddingSize,
    indexes: indexSize,
    total_bytes: memoriesCount * memoryRowSize + embeddingCount * embeddingSize + indexSize,
    total_mb:
      Math.round(
        ((memoriesCount * memoryRowSize + embeddingCount * embeddingSize + indexSize) /
          1024 /
          1024) *
          100,
      ) / 100,
  };
}

// Lifecycle summary for reporting.
export function buildLifecycleSummary(db, projectKey, counts) {
  const active = counts.active || 0;
  const retained = counts.retained || 0;
  const total = counts.total || 0;
  const withEmbeddings = counts.embedded || 0;

  const sizeEstimate = estimateDbSize(active, withEmbeddings);

  return {
    project_key: projectKey,
    total_memories: total,
    active_memories: active,
    retained_memories: retained,
    memories_with_embeddings: withEmbeddings,
    estimated_db_size_mb: sizeEstimate.total_mb,
    retention_breakdown: {
      active: active,
      superseded: counts.superseded || 0,
      deleted: counts.deleted || 0,
      expired: counts.expired || 0,
    },
  };
}
