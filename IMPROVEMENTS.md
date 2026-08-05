# kimi-memory Improvements & Fixes

This document describes comprehensive improvements to kimi-memory addressing observability, reliability, search quality, performance, and operational concerns.

## Summary of Changes

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

### 5. Search Quality & Ranking (`src/search.js`)

- **Title boosting**: Prioritize title matches over content
- **Flexible sorting**:
  - `relevance` (FTS5 rank, default)
  - `recent` (updated_at DESC)
  - `confidence` (confidence DESC)
  - `priority` (priority DESC)
- **Query enhancements**:
  - Support for quoted phrases: `"exact phrase"`
  - Negation support: `-exclude`
  - Query normalization and validation
- Enhanced `memory_recall` tool with `sort_by` and `recent_first` parameters

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

### Search with Title Boost & Sorting

```bash
# Get recent memories first
memory_recall(query="deployment", sort_by="recent", limit=10)

# Sort by confidence (importance)
memory_recall(query="decision", sort_by="confidence", limit=10)

# Find similar memories
memory_similar(id="mem_123", threshold=0.7, limit=20)
```

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
- Concurrency tracking and contention detection
- Search query normalization and title boosting
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
2. **Better search**: Use `sort_by="recent"` or `confidence` for ranked results
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
