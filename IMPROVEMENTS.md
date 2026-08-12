# kimi-memory Improvements & Fixes

This document describes comprehensive improvements to kimi-memory addressing observability, reliability, search quality, performance, and operational concerns.

## Summary of Changes

### 0. ACL / Visibility Model (`src/acl.js`, `src/persist.js`, `src/server.js`, `src/cli.js`) — Phase 1 of TencentDB port

Ported from TencentDB-Agent-Memory's `AssetVisibility` and ACL primitives. Additive — every existing tool, save, and recall continues to work byte-identical; the new fields default to safe values.

- **Five visibility levels** mirroring Tencent's enum: `private | team | restricted | agent | task`. `private` is the default for every new save so a row never accidentally becomes cross-project visible.
- **New columns on `memories`** (v10 schema bump): `visibility`, `shared_with` (JSON-encoded list of principal descriptors), `team_id`, `agent_id`, `user_id`, `session_id`, `task_id` (the last five are nullable principal identity tags).
- **New `memories_acl` table**: explicit grant rows `(memory_id, principal_kind ∈ {user, team, role, agent}, principal_id, granted_at)` with `UNIQUE(memory_id, principal_kind, principal_id)` for idempotent inserts.
- **New `_shared/memory.sqlite` DB** at `$KIMI_CODE_HOME/kimi-memory/_shared/` with literal `project_key='_shared'`. Lazy-created on first `acl_share_memory` call with `to_shared_pool: true`.
- **New exports** in `src/persist.js`: `shareMemory(db, key, [ids], { visibility, sharedWith, toSharedPool, kimiHomeDir })` returning `{ moved, updated }`; `openSharedDb(home)`; `sharedDbPath(home)`; `SHARED_PROJECT_KEY` / `SHARED_DIR_NAME` constants; `validVisibilityLevels()`.
- **New exports** in `src/acl.js`: `validateVisibility(v)`, `validatePrincipalKind(v)`, `validateSharedWith(arr)`, `grantMemoryAcl(db, key, memId, kind, id)`, `revokeMemoryAcl(...)`, `listMemoryAcls(...)`, `parsePrincipalDescriptor(s)`.
- **5 new MCP tools**: `acl_grant`, `acl_revoke`, `acl_list`, `acl_share_memory`, `acl_resolve_principal`. Total tool count: **26 → 31**.
- **`memory_recall` gains an optional `visibility` filter** (single string or array of level names) that narrows both the FTS and the vector channels.
- **`memory_save` / `memory_save_bulk` / `memory_update`** accept the same v10 fields; existing callers that omit them get safe defaults.
- **CLI**: `node src/cli.js acl list|grant|revoke <memory-id> [--cwd <path>] [--scope project|global] [--json]`.
- **Idempotency**: `acl_grant` no-ops via UNIQUE; `acl_share_memory` re-running is a no-op for already-shared rows; `acl_revoke` on a non-existent grant returns `removed=false`.
- **Schema**: single `SCHEMA_VERSION = 9 → 10` bump; the v10 migration `migrateAddVisibilityAndSharedWith` is idempotent and backfills `visibility='private'` / `shared_with='[]'` for pre-existing rows via the column defaults.

Reuses: `linkMemory` typed-edge pattern as a model for ACL grant IDs (per-project, idempotent on `(memory_id, principal_kind, principal_id)`); `mergeWithScope` extended with the `_shared` DB; `nowIso` from `src/util.js` for granted_at stamps; the v10 SQL CHECK is added at column-add time so the migration does not need the v5-style probe-then-rebuild.

### 1. Error Observability & Diagnostics (`src/diagnostics.js`)

- **Structured JSON-line logging** to `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log`
- Error classification by type:
  - `hook_error`: Hook execution failures
  - `auto_extract_error`: LLM-driven memory extraction issues
  - `embedding_error`: Model loading, timeout, dimension mismatches
  - `persist_error`: Database operation failures
  - `conversation_ingest_error`: Session archive ingestion problems
  - `config_validation_error`: Configuration parsing/validation issues
- Diagnostic queries: `getRecentLogs(limit, typeFilter)`, `getErrorSummary(hoursBack)`
- New MCP tool: `memory_diagnostics` — retrieve error summaries and recent logs

### 1.5. RRF (Reciprocal Rank Fusion) retrieval (`src/persist.js`, `src/server.js`, `src/cli.js`) — Phase 2 of TencentDB port

Ported from TencentDB-Agent-Memory's `core/store/search-utils.ts` (`rrfMerge`, `RRF_K = 60`). Additive — every existing call site that does not opt in to the legacy `fusion: 'weighted'` mode now goes through RRF.

- **New constant `RRF_K = 60`** mirrors TencentDB's value; lower values sharpen the curve (rank-1 hits dominate more), the standard RRF textbook value is the default.
- **New pure helper `combineRrfScores({ ftsRank, vecRank, k })`** exported from `src/persist.js`. Missing / non-finite / sub-1 channel ranks contribute 0; valid ranks contribute `1 / (k + rank)`. Returns the sum across both channels.
- **`searchMemories` refactor** — each channel (FTS5, vector) now produces a 1-indexed rank; the combiner runs over both ranks per candidate. The legacy 0.5/0.5 weighted blend is preserved behind `fusion: 'weighted'`; default is `fusion: 'rrf'`.
- **`minScore` floor retuned** — the previous default of 0.2 was tuned for the 0.5/0.5 blend (a rank-3 FTS-only hit scored 0.5·1/3 ≈ 0.167, just below 0.2). Under RRF (RRF_K=60), a rank-1 hit in either channel scores 1/61 ≈ 0.0164, so the default drops to 0.01 to keep the rank-1 surface intact. Tests that need every FTS candidate pass `minScore: 0`.
- **`includeScore: true` exposes per-channel ranks** — every recalled row now carries `fts_rank`, `vec_rank`, and (under RRF) `rrf_score`; the legacy `fts_score` + `vec_score` fields are still emitted under `fusion: 'weighted'`. Missing channel ranks are surfaced as `Number.POSITIVE_INFINITY` so the test suite can distinguish "not ranked here" from "ranked low here".
- **`memory_recall` gains optional `fusion` + `rrf_k` inputs** — `fusion ∈ {'rrf' | 'weighted'}` (default `rrf`), `rrf_k` integer 1..1000 (default 60). Both are forwarded verbatim to `searchMemories`.
- **CLI** — `node src/cli.js recall <query> [--fusion rrf|weighted] [--rrf-k 60] [--visibility team,private]`. Invalid `--fusion` or out-of-range `--rrf-k` exit 1 with a friendly error.

Reuses: the existing `cosineSimilarity` from `src/embedding.js` (vector channel unchanged); the FTS candidate builder at `src/persist.js:1006-1034`; the `bumpAccess` access-tracking call at the end of `searchMemories`; the `mergeWithScope` in `src/server.js` extended to preserve the per-channel ranks when `scope === 'all'`; the `diversifyHitsByType` reranker in `src/hooks/run.js` operates on the post-RRF ranked set.

### 1.6. Chat Memory L0→L1→L2→L3 (Persona tier model) (`src/persist.js`, `src/server.js`) — Phase 3 of TencentDB port

Ported from TencentDB-Agent-Memory's layered Chat Memory (`core/record/l1-extractor.ts`, `core/scene/scene-extractor.ts`, `core/persona/persona-generator.ts`). Additive — every existing save still lands at L0 by default; tier transitions are explicit calls.

- **Four tier levels**: `L0 | L1 | L2 | L3`. `L0` = un-promoted raw save; `L1` = Stop-hook auto-extract promoted it; `L2` = access pattern promoted it; `L3` = agent/operator curated. Mirrors Tencent's distillation pipeline.
- **New columns on `memories`**: `tier TEXT NOT NULL DEFAULT 'L0' CHECK (tier IN ('L0','L1','L2','L3'))`, `persona_id TEXT` (nullable).
- **New `persona_promotions` table**: `(id, memory_id, from_tier, to_tier, reason, at)` — the audit log for every transition. Index on `memory_id` for fast history queries.
- **New exports** in `src/persist.js`: `setMemoryTier(db, key, id, targetTier, { reason })` (explicit move), `promoteMemory(...)` (one-tier-up), `demoteMemory(...)` (one-tier-down), `listTierHistory(db, key, id, { limit })` (audit log oldest-first). All return `{ memory, transition }`; transition is `null` when no actual change happened.
- **`saveMemory` accepts `tier` + `persona_id`**; pre-existing rows default to `tier='L0'` and `persona_id=null` (column defaults).
- **`rowToMemory` surfaces `tier` and `persona_id`**; both are first-class fields in every recalled row.
- **`searchMemories` gains per-tier shaping**:
  - `tier: 'L2' | ['L1','L2']` — narrows both the FTS and the vector channels to matching tiers.
  - `tierBudgets: { L0: 2, L1: 2, L2: 1, L3: 1 }` — caps each tier independently after the standard selection. Tiers not in the map are uncapped.
  - `maxCharsPerMemory` — truncates an individual row's content body to the budget with a "…(truncated)" suffix (surrogate-pair safe; code-point aware).
  - `maxTotalRecallChars` — drops tail rows once the cumulative content length exceeds the budget.
- **4 new MCP tools** (`TOOL_DEFS[31..34]`): `memory_set_tier`, `memory_promote`, `memory_demote`, `memory_tier_history`. Total tool count: **31 → 35**.
- **`memory_recall` extended inputs**: `tier`, `tier_budgets`, `max_chars_per_memory`, `max_total_recall_chars` — all optional, all backward-compatible (omitted = previous behavior).
- **Idempotency**: `setMemoryTier` is a no-op when the row is already at the target tier; `promoteMemory` / `demoteMemory` are no-ops at the boundary (`L3` / `L0` respectively); transitions are not double-recorded.
- **Hook wiring**: zero new hook events. The Stop-hook auto-extract path promotes fresh saves from `L0 → L1` once a candidate clears the secret / dedupe gates; the existing `memory_reinforce` path can promote `L1 → L2` after a configurable access threshold (Phase 5 wiring if useful; not required for correctness).

Reuses: `recordConversationEvent` audit-log pattern as a model for `persona_promotions`; `nowIso` from `src/util.js` for `at` stamps; `shortId(hashId(...))` for the deterministic promotion row id; the existing `getMemory` round-trip so `setMemoryTier` returns the post-write row in the same shape every other tool returns.

### 1.7. Wiki / LLM-Wiki (`src/wiki.js`, `src/persist.js`, `src/server.js`) — Phase 4 of TencentDB port

Ported from TencentDB-Agent-Memory's `MemoryKnowledge/engines/wiki/` + `MemoryKnowledge/openapi.yaml`. Pages live alongside the per-project memories table.

- **New tables** (`migrateAddWikiTables`):
  - `wiki_pages` — `(wiki_id TEXT PRIMARY KEY, project_key, service_id, team_id, name, body, summary, updated_at)` with `UNIQUE(project_key, name)` for idempotent upsert. wiki_id is `wiki-` + 8 hex chars (deterministic from `hashId('wiki', projectKey, name)`).
  - `wiki_links` — `(from_wiki_id, to_wiki_id, project_key, kind CHECK IN ('mentions','derived_from','contradicts','supersedes'), weight, created_at)` with `UNIQUE(project_key, from_wiki_id, to_wiki_id, kind)`. Future-target edges (`to_wiki_id='pending:<name>'`) are recorded so the link survives a re-save and resolves once the target lands.
  - `wiki_fts` — FTS5 over `(name, body, summary)` with `unicode61 remove_diacritics 2`.
  - Indexes on `wiki_links.from_wiki_id`, `to_wiki_id`, and `wiki_pages.project_key` for fast traversal.
- **Pure helpers in `src/wiki.js`**: `extractWikiLinks(body)` parses `[[wiki-name]]` and `[text](wiki:name)` markers; `resolveWiki(db, key, name)` name→page lookup; `upsertWikiPage(db, key, opts)` idempotent on `(project, name)` (rewrites body / summary / outgoing edges in place); `getWikiPage(db, key, { wikiId, name })` by id (preferred) or name; `traverseWiki(db, key, seedId, { max_hops, kinds })` BFS walk with `max_hops` cap and per-kind filter; `backlinksWiki(db, key, wikiId, { kinds })` incoming edges.
- **5 new MCP tools** (`TOOL_DEFS[35..39]`): `wiki_upsert_page`, `wiki_get_page`, `wiki_traverse`, `wiki_backlinks`, `wiki_resolve`. Total tool count: **35 → 40**.
- **CLI** — none in this phase; wiki ops go through the MCP tools directly. Wiki pages are project-scoped (per-project DB), so cross-project wiki would need a shared-page convention; not implemented in v10.
- **Idempotency**: `wiki_upsert_page` rewrites in place; `UNIQUE(project_key, name)` makes the upsert atomic in one transaction; pending-target edges resolve when the named page lands.

Reuses: `nowIso` + `shortId(hashId(...))` from `src/util.js` for the deterministic wiki_id; `linkMemory` typed-edge pattern at `src/persist.js:1390` as the model for `wiki_links`; the v5-style probe-then-rebuild migration pattern for adding the new tables (idempotent).

### 1.8. CodeGraph (`src/codegraph.js`, `src/persist.js`, `src/server.js`) — Phase 5 of TencentDB port

Ported from TencentDB-Agent-Memory's `MemoryKnowledge/engines/code/` + the Code-Graph endpoints in `MemoryKnowledge/openapi.yaml`. Edges live in the existing `memory_edges` table so the BFS reuses the same data shape.

- **`memory_edges.kind` extended** with three new values: `imports`, `calls`, `defines`. The v10 + Phase 5 migration `migrateAddCodegraphEdges` rebuilds the CHECK constraint (probe-then-rebuild, same pattern as v5 conclusion + v10 visibility). The migration also adds a `metadata TEXT NOT NULL DEFAULT '{}'` column for edge payload `{file, lang, range}`.
- **`extractSymbolsFromText(text, ext)`** in `src/codegraph.js` returns `{ symbols: [{name, kind}], imports: [{module, symbols}] }`. Handles `.js` / `.mjs` / `.cjs` / `.ts` (function / class / const + ES `import {x,y} from 'mod'`) and `.py` (`def NAME` / `class NAME` + `from MOD import a, b`). Other extensions return empty arrays so the walker skips them gracefully.
- **`extractCodeGraph(root, { limit })`** walks a directory, skips `node_modules` and dotdirs, reads every `.js`/`.ts`/`.py` file, runs `extractSymbolsFromText` on each, returns `[{file, ext, symbols, imports}]`. Default cap 200 files.
- **`buildCodeGraphEdges(db, key, files, { apply, kind })`** scans the project's memories for each file's symbols via `LIKE`-based intersection. When ≥2 memories share a symbol, an edge is inserted (kind defaults to `'calls'`). `apply=false` is a dry-run returning `{inserted: 0, candidates: ≥1}` without committing; `apply=true` persists edges with `metadata = {file, lang, range}`. Self-loops and pairs with only one matching memory are dropped.
- **`queryMemoryGraph(db, key, seedId, { kind, max_depth })`** BFS walk over the memory graph starting from a seed memory. `max_depth=0` returns just the seed; `kind` filter restricts which edge kinds are walked. Returns `{nodes: [{id, ...row}]}`.
- **6 new MCP tools** (`TOOL_DEFS[40..45]`): `codegraph_extract`, `codegraph_build_edges`, `codegraph_query_symbol`, `codegraph_impact_path`, `codegraph_callers`, `codegraph_callees`. Total tool count: **40 → 46**.
- **CLI** — none in this phase; codegraph ops go through the MCP tools. The walker is async (uses `node:fs/promises`) so `codegraph_extract` must be invoked through the MCP server, not from a synchronous hook.
- **Idempotency**: edge ids are deterministic (`shortId(hashId('edge', key, from, to, kind, file))`), so re-running with the same inputs is a no-op via the `UNIQUE(project_key, from_id, to_id, kind)` constraint and `INSERT OR IGNORE`.

Reuses: the existing `memory_edges` table + indexes (`idx_memory_edges_from`, `idx_memory_edges_to`); `nowIso` + `shortId` from `src/util.js`; `linkMemory` typed-edge INSERT pattern; the `mergeWithScope` / `diversifyHitsByType` helpers in `src/hooks/run.js` stay unchanged (they walk memory_edges too).

### 1.9. Skill assets (`src/persist.js`, `src/server.js`) — Phase 6 of TencentDB port

Ported from TencentDB-Agent-Memory's `MemoryCore/src/core/skill/` module (skill-core + skill-store-ddl + skill-permission). Skills are memories with `type='skill'` that carry a structured trigger surface in `metadata.trigger`.

- **`memories.type` CHECK extended** with `skill` via `migrateAddSkillType`. Probe-then-rebuild (same pattern as v5 conclusion / v10 visibility). FTS5 re-seeded from the rebuilt memories table so the new type is searchable.
- **`saveMemory` accepts `type: 'skill'`**; the `metadata.trigger = { commands, paths, keywords }` shape is preserved on round-trip. A top-level `processing_status: 'pending'` field on the save input is folded into `metadata.processing_status` so skill extractors can flag a row as in-flight without exposing a new column.
- **`matchSkillTriggers(db, key, args, { limit })`** scores every active skill against a tool-call args shape. `commands` substring-match on the `command` field (weight +2.0); `paths` suffix/segment match on `file_path` (weight +1.5); `keywords` substring on any other string value (weight +1.0). Returns the top `limit` matches by score; empty triggers produce no match.
- **`recordSkillInvocation(db, key, skillId, { success, toolName, durationMs })`** inserts a row into `skill_invocations` with a unique id (`shortId(hashId('skinv', key, id, stamp))` where `stamp` mixes millisecond + nanosecond + a random int to avoid same-ms PRIMARY KEY collisions).
- **`updateSkillInvocationStats(db, key, skillId)`** aggregates `skill_invocations` into `{ invoke_count, success_rate }`.
- **`listSkillMemories(db, key)`** returns every `type='skill'` + `status='active'` row whose `metadata.processing_status` is not `'pending'`. Pending rows are filtered so the dashboard / hook can show the extraction queue as separate from the live skill set.
- **New table** `skill_invocations` (`id, skill_id, project_key, tool_name, success, duration_ms, invoked_at`) with index `(project_key, skill_id)`.
- **MCP tool surface**: Phase 6 deliberately ships the 4 scaffold-required exports (`matchSkillTriggers`, `recordSkillInvocation`, `updateSkillInvocationStats`, `listSkillMemories`) and the schema migration; the 15-tool skill_* family from the plan (skill_create / update / patch / delete / get / list / search / versions / files_write / files_remove / file_read / files_listing / extract / conversation_add / conversation_force_archive) is not implemented in this revision — they map onto the same memory/edge primitives and can be added in a follow-up commit without schema changes.
- **Hook wiring**: zero new hook events. `matchSkillTriggers` is exported so a follow-up PR can wire it into the `UserPromptSubmit` path next to `runToolRecall`; the current revision keeps that wiring as a separate concern so the scaffold tests stay focused on the persistence layer.

Reuses: the existing `memories` table; `nowIso` + `shortId(hashId(...))` from `src/util.js`; `getMemory` round-trip so every read returns the same shape every other tool returns.

### 1.10. Memory Proxy (`src/proxy/server.js`, `src/cli.js`) — Phase 7 of TencentDB port

Ported from TencentDB-Agent-Memory's `MemoryProxy/` module (the third container in their `deploy/global-images/start-all.sh` stack: `proxy:latest` on port 8096, fronting Claude Code via `ANTHROPIC_BASE_URL`). The kimi-memory proxy is a thin Node `http` server that translates inbound POSTs to the existing TOOL_DEFS handlers — same shape, same validation, same error envelope as the stdio MCP server.

- **Endpoint surface** (`http://<host>:<port>`):
  - `POST /tools/<tool_name>` — invoke the named tool with a JSON body. Returns `{ content: [{type:'text', text: JSON.stringify(payload)}] }` (the same envelope the stdio MCP server emits).
  - `GET /tools` — list the tool names the proxy can dispatch.
  - `GET /healthz` — liveness probe, no auth required (for k8s probes).
  - `POST /shutdown` — graceful shutdown, auth required.
  - CORS: `access-control-allow-origin: *`; preflight `OPTIONS` returns 204.
- **Auth**: `KIMI_MEMORY_PROXY_TOKEN` env var. When set, every `/tools/...` request must carry `Authorization: Bearer <token>`. When unset, the proxy refuses to start unless `KIMI_MEMORY_PROXY_AUTH=off` (intended for dev only). Default host is `127.0.0.1` to keep the port off the network.
- **CLI**: `node src/cli.js serve-http [--port 7331] [--host 127.0.0.1] [--auth-token-env KIMI_MEMORY_PROXY_TOKEN] [--no-auth]`. SIGINT / SIGTERM trigger a graceful close.
- **Tool surface**: the proxy dispatches to the same `makeServer({ kimiHomeDir, pluginRootDir, logger })` instance the stdio MCP server uses, so every tool the stdio server exposes is callable through HTTP with zero additional registration. The implementation pokes at the McpServer's internal `_registeredTools` map; if the SDK shape ever drifts, the proxy returns `500 internal` rather than silently dropping the call.
- **MCP tool surface**: zero new tools. The proxy is a transport, not a re-implementation. TencentDB's separate `proxy_start` / `proxy_stop` / `proxy_status` MCP tools are not ported — the same lifecycle is exposed via `node src/cli.js serve-http` + signal handling, which is the more conventional shape for a Kimi plugin.

Reuses: the existing `makeServer` factory in `src/server.js`; `openScopeDb` + `recordProjectPath` for per-request isolation; `looksLikeSecret` in `src/extract.js` runs at the lowest layer so every write inherits the secret check; `safeJsonParse` in `src/util.js` for body parsing.

### 2. Reliability & Retry Logic (`src/retry.js`)

- **Exponential backoff with jitter** to avoid thundering herd
- Semantic error classification:
  - **Retryable**: ECONNRESET, ETIMEDOUT, RATE_LIMIT, etc.
  - **Non-retryable**: EAUTH, config missing, validation errors
- Three wrapper functions:
  - `withRetry()` — generic retry wrapper
  - `withLlmRetry()` — LLM-specific retry (rate limits, timeouts)
  - `withDbRetry()` — database lock retry
- Auto-extract now retries LLM calls up to 3 times before giving up

### 3. Embedding Robustness (`src/embedding.js`)

- **Explicit version pinning**: `Xenova/all-MiniLM-L6-v2@v1` (prevents silent incompatibilities)
- **Dimension validation** on encode/decode:
  - `encodeVector()` throws `KIMI_MEMORY_EMBED_DIM_MISMATCH` on dimension mismatch
  - `decodeVector()` validates BLOB size and checks for NaN/Inf values
- Error logging for timeout, dim mismatch, model load failures
- New exports: `getModelInfo()`, `validateModelCompatibility()` for diagnostics

### 4. Concurrency & Locking (`src/concurrency.js`)

- **Concurrency tracking**: `recordWriteStart/End()` detect contention
- **Timeout improvements**:
  - SQLite `PRAGMA busy_timeout` increased from 5s → 30s
  - Better handling of SQLITE_BUSY errors
- **Bulk operations**: `saveMemoryBulk()` now collects per-item errors instead of all-or-nothing rollback
- **Performance logging**: Track slow/contending writes via diagnostics

### 5. Search Quality & Ranking

- **Hybrid FTS5 + cosine recall (RRF-fused)**: combines keyword ranking from
  `memories_fts` with embedding-cosine similarity from the `embedding`
  BLOB column. See `src/persist.js#searchMemories` and the v10 RRF
  combinator (`combineRrfScores`).
- **Query enhancements**:
  - Support for quoted phrases: `"exact phrase"`
  - Negation support: `-exclude`
  - Per-type balancing via `perType: true` (used by the hook layer so a
    recall surfaces a mix of conventions, procedures, and notes
    rather than N rows of the same type).
  - Per-tier budgets via `tier_budgets` and tier-shaped truncation via
    `max_chars_per_memory` / `max_total_recall_chars` (v10).
- Visibility filter (`visibility: 'team' | ['private', 'team']`) narrows
  both channels; the same opt is documented in `acl_share_memory`.

> Title boosting and `sort_by` / `recent_first` are documented in older
> revisions of this file but were never wired into `searchMemories`. The
> tool schema accepts `recent_first` and `sort_by` but ignores them;
> `memory_recall` returns FTS-ranked results. Don't rely on either.
> (Audit SG-2 / SG-3.)

### 6. Conversation Archival & Lifecycle (`src/lifecycle.js`)

- **Archive identification**:
  - `getConversationsToArchive()` — find old conversations for storage optimization
  - `getMemoriesToPrune()` — identify expired/old soft-deleted memories
- **Size estimation**: `estimateDbSize()` predicts database footprint
- **Retention policies**: Configurable archival and purge strategies
- **Lifecycle summary**: Comprehensive memory/conversation stats for reporting

### 7. Performance Optimization (`src/performance.js`)

- **Strategic indexes** (8 new ones):
  - Time-range queries: `idx_memories_created_at`
  - Importance sorting: `idx_memories_confidence`, `idx_memories_priority`
  - Type+status filtering: `idx_memories_type_status`
  - Active-only reads: `idx_memories_active`
  - Edge traversal: `idx_memory_edges_to_kind`
  - Conversation queries: `idx_conversation_events_created`
  - Prune lookups: `idx_project_paths_canonical`
- **Maintenance functions**:
  - `ensurePerformanceIndexes()` — idempotent index creation
  - `vacuumDb()` — reclaim space from deletes
  - `analyzeDb()` — update query planner statistics
- **Batch embedding**: `batchEmbed()` optimizes model calls
- **Recommendations**: `getMaintenanceRecommendations()` suggests actions

### 8. Configuration Management (`src/config.js`)

- **Custom TOML parser** (replaces hand-rolled version):
  - Handles comments, quoted strings, sections, basic types
  - Schema validation with defaults
  - Environment variable overrides
- **Validated config schema**:
  - `disable_auto_extract`
  - `disable_embeddings`
  - `embed_timeout_ms`
  - `llm_model`, `llm_provider`
- **Error handling**: Invalid configs fall back to defaults safely

## Usage Examples

### Retrieve Error Logs

```bash
# Query diagnostics via MCP tool
memory_diagnostics(hours_back=24, type_filter="auto_extract_error")

# Or via CLI
kimi-memory diagnostics --hours-back 24 --type auto_extract_error
```

### Search Examples

```bash
# Recall across the active project (default scope='all')
memory_recall(query="deployment", limit=10)

# Find similar memories
memory_similar(id="mem_123", threshold=0.7, limit=20)
```

(`sort_by` and `recent_first` were removed from the documented surface;
they were never wired into `searchMemories`. See note in §5.)

### Lifecycle Management

```bash
# Check what should be archived
lifecycle_report(project_cwd)

# Archive conversations older than 30 days
archive_conversations(project_cwd, days_old=30)

# Find and delete expired/old soft-deleted memories
prune_memories(project_cwd, purge_days=90)
```

### Performance Tuning

```bash
# Ensure all performance indexes exist
db.exec("PRAGMA optimize") // Or call ensurePerformanceIndexes()

# Get maintenance recommendations
maintenance_status = getMaintenanceRecommendations(db_stats)

# Reclaim space from deletes
vacuumDb(db)
```

## Testing

Comprehensive test suite in `tests/21-comprehensive-improvements.test.js`:

```bash
npm test tests/21-comprehensive-improvements.test.js
```

Coverage includes:

- Exponential backoff calculations with jitter
- Config parsing and validation
- Lifecycle identification (archival candidates, prunable memories)
- Edge cases and error handling

## Migration Guide

### For Operators

1. **Enable diagnostics monitoring**: Check `memory_diagnostics` tool for errors
2. **Review performance**: Run `getMaintenanceRecommendations()` after heavy usage
3. **Set retention policies**: Configure `lifecycle.js` policies if needed

### For Agents

1. **Improved error handling**: Auto-extract now retries failed LLM calls automatically
2. **Better search**: `memory_recall` accepts the per-type / per-tier / visibility filters documented in §5 above.
3. **Config validation**: Errors in config.toml are logged to diagnostics

### For Developers

1. **New modules**: Import helpers from `src/retry.js`, `src/concurrency.js`, `src/search.js`, etc.
2. **Logging**: Use `logAutoExtractError()`, `logEmbeddingError()`, etc. for diagnostics
3. **Testing**: See `tests/21-comprehensive-improvements.test.js` for patterns

## Backward Compatibility

All changes are backward compatible:

- Existing tools work unchanged
- New tool parameters are optional
- Database schema unchanged
- Existing queries still work (enhanced with indexing)

## Known Limitations & Future Work

- Config validation doesn't check LLM provider credentials
- Archive storage format (JSON/SQLite) not yet implemented
- Fuzz testing for extract prompts not included
- GDPR export/delete tools in progress

## Security Audit (2026-08-12)

A `harden-and-clean` pass surfaced the following items. **None of the remaining issues have upstream fixes** as of audit date — they are tracked here so the situation is visible, not hidden.

### Transitive CVEs via `@huggingface/transformers`

| Advisory | Package | Severity | Status | Mitigation |
|---|---|---|---|---|
| GHSA-xcpc-8h2w-3j85 | `adm-zip <0.6.0` (via `onnxruntime-node`) | high | No fix available | The embedding pipeline never ingests untrusted ZIP files. The vulnerability requires a crafted ZIP, which the onnxruntime path does not feed. Re-evaluate when upstream resolves. |
| GHSA-f88m-g3jw-g9cj | `sharp <0.35.0` (via `onnxruntime-node`) | high | No fix available | Same reasoning: `sharp` is used by the embedding for image-preprocessing of model inputs, not user-supplied image uploads. The model's tokenizer gates input shape. |

### Previously fixed (lockfile-only update)

- `fast-uri 3.0.0-3.1.4` (GHSA-7p8r-x3mc-p8w7, host confusion via backslash authority introducer) — fixed transitively by `npm audit fix` on 2026-08-12. No code changes required.

### Re-evaluation cadence

Re-run `npm audit` on every `@huggingface/transformers` minor bump. The two unfixed advisories are blocking only if the attack surface changes (e.g., if a future feature takes untrusted images or ZIPs from `memory_save`). Today's threat model does not.

