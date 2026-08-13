---
module: src/persist
last_verified: 2026-08-13
---

# src/persist

## Summary

The SQLite data layer. Ten modules. connection.js owns the schema (SCHEMA_VERSION=11), the ordered idempotent MIGRATIONS array, the cached handle map (openDb/closeDb), the shared DB path (openSharedDb), and the WAL/busy_timeout/synchronous PRAGMAs. memories.js owns CRUD plus row→memory shaping (rowToMemory), the secret-scanning pre-write (assertNoSecret), FTS5 upsert, and the in-flight embedding microtask tracker. search.js is hybrid FTS5 + cosine with RRF fusion. edges.js is typed edges (related/supports/contradicts/supersedes/synthesizes/imports/calls/defines). share.js is v10 visibility + tier + the cross-project shared DB move. reinforce.js is the Ebbinghaus-style stability/stability_days/refresh. skills.js is the v10 trigger-match + skill_invocation audit. project.js is per-project working memory + conversations + ingest cursor + re-clone detection + reset. index.js is the public barrel. re-exports.js breaks the circular dependency with tool-registry/codegraph by re-exporting them.

## Public API

- connection.js — openDb(dbPath), closeDb(dbPath?), flushEmbeddings({timeoutMs?}), openSharedDb(kimiHomeDir), sharedDbPath(kimiHomeDir), SHARED_DIR_NAME, SHARED_PROJECT_KEY, sharedDataDir(kimiHomeDir). Also re-exports statSync for project.js detectReclone.
- memories.js — saveMemory, saveMemoryBulk, getMemory, listMemories, deleteMemory, mergeMemory, listConclusionsFor, getParents, memoryCounts, projectStatus, resetProjectDryRunCounts, promotePendingRows, memoryId, rowToMemory.
- search.js — combineRrfScores({ftsRank, vecRank, k}), searchMemories(db, key, query, opts), similarMemories(db, key, id, opts), backfillEmbeddings(db, key, opts).
- edges.js — linkMemory, unlinkMemory, listEdges, validEdgeKinds, isValidEdgeKind.
- share.js — validateVisibility, validatePrincipalKind, validateSharedWith, grantMemoryAcl, revokeMemoryAcl, listMemoryAcls, parsePrincipalDescriptor (in src/acl.js), shareMemory, setMemoryTier, promoteMemory, demoteMemory, listTierHistory, validVisibilityLevels, validTiers, isValidTier.
- reinforce.js — reinforceMemory, reinforceIfStale, decayMemories.
- skills.js — matchSkillTriggers, recordSkillInvocation, updateSkillInvocationStats, listSkillMemories.
- project.js — setWorkingMemory, getWorkingMemory, clearWorkingMemory, listWorkingMemory, upsertConversation, getConversation, listConversations, getConversationEvents, searchConversationEvents, recordConversationEvent, updateConversationProgress, loadIngestState, saveIngestState, recordProjectPath, listProjectPaths, detectReclone, resetProject.

## Data shape

Every table is created by SCHEMA_SQL or by an idempotent migration in MIGRATIONS (connection.js:22-…). Tables: memories, working_memory, conversations, conversation_events, memories_fts, memory_edges, memory_synthesizes, project_paths, schema_meta, memories_acl, persona_promotions, wiki_pages, wiki_links, wiki_fts, skill_invocations. Indexes cover (project_key, type), (project_key, status), (project_key, embedded_at), (project_key, embedding_dim), expires_at, superseded_by, plus FTS5 mirroring. PRAGMAs: journal_mode=WAL, foreign_keys=ON, synchronous=NORMAL, busy_timeout=30000.

## Failure modes

- Write contention under high concurrency: WAL + 30 s busy_timeout lets the hook and the MCP server hold separate handles; SQLITE_BUSY after 30 s is logged to _diagnostics/hooks.log via logPersistError.
- Corrupt JSON columns (tags, metadata, provenance): rowToMemory returns shape-correct fallbacks rather than throwing. The recall path no longer breaks on a single bad row.
- Embedding model unavailable: scheduleEmbeddingUpdate (memories.js) writes last_embed_error and leaves embedding NULL. The vector branch in searchMemories then skips the row silently.

## Boundaries

- Does not bind network ports or fetch remote resources — exceptions are explicit (src/embedding.js for the model, src/extract.js for the LLM, both fail-open).
- Does not write to user files outside $KIMI_CODE_HOME/kimi-memory/. No writes to Kimi sessions directory.
- Does not import from any module under src/hooks — direction is one-way (hooks → persist), no cycles.

## Tests

tests/02-persist.test.js — openDb + schema probe + migration idempotence. tests/03-wire.test.js — wire ingest cursor regression. tests/08-edges.test.js — edge CRUD. tests/10-decay.test.js — Ebbinghaus math. tests/11-conclusions.test.js — synthesizes + conclusion read paths. tests/12-prune.test.js — orphan-project detection. tests/14-secret-block.test.js — secret scanning at save. tests/18-embedding-integration.test.js — embedding round-trips. tests/24-rrf-scoring.test.js — RRF math. tests/25-skills.test.js — skill triggers. tests/26-codegraph.test.js — codegraph edges. tests/29-visibility-acl.test.js — visibility + ACL + share. tests/30-redact-secrets.test.js — transcript redaction. tests/31-row-corruption.test.js — corrupt JSON column fallbacks. tests/32-batch2-fixes.test.js — recent batch fixes. Per-tool round-trips: tests/05-mcp-protocol.test.js.
