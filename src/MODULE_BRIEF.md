---
module: src
last_verified: 2026-08-13
---

# src

## Summary

Root src layout. Holds the MCP entrypoint (src/mcp/{launcher,main}.js plus src/server.js), the cross-cutting modules (embedding, extract, decay, consolidate, auto-gc, diagnostics), the stand-alone CLI (src/cli.js), and the persistence barrel (src/persist.js). 45 JS files; most under 300 lines, with src/server.js (~2770), src/hooks/run.js (~1580), and src/persist/memories.js (~830) being the load-bearing pieces.

## Public API

- src/server.js — makeServer({kimiHomeDir, pluginRootDir, logger}) returns an MCP server with 46 registered tools (TOOL_DEFS array).
- src/cli.js — kimi-memory bin subcommands: list, get, status, recall, prune, reset-project, acl {list,grant,revoke}.
- src/persist.js — public-data barrel re-exporting every helper in src/persist/*.js; legacy callers can import the same names.
- src/util.js — kimiHome, nowIso, safeJsonParse, hashId, shortId, PATH_REGEX, SHELL_VERB_REGEX, projectKeyFromCwd.
- src/embedding.js — embedText(text), encodeVector, decodeVector, cosineSimilarity, EMBEDDING_DIM, EMBEDDING_MODEL, lastEmbeddingError, _resetForTests, _setPipelineStubForTests.

## Data shape

Convention: each cross-cutting module owns one concern (embedding, secret detection, decay math, project-key derivation, ACL vocabulary). The persist directory owns SQLite; hooks owns the lifecycle runner; this root owns orchestration and shared utilities.

## Failure modes

- Auto-extract failures (extract.js): the LLM call can return null/garbage/non-JSON; every path is fail-open and counted in result.skipped.
- Embedding load failures (embedding.js): embedText returns null on timeout or model-load error; persist interprets null as embeddings-unavailable and writes last_embed_error.
- Diagnostics log write failures (diagnostics.js): every log call is wrapped in .catch(()=>{}); hook code never blocks on a log write.

## Boundaries

- Does not import @huggingface/transformers at module top-level — the import is lazy inside getPipeline() to keep MCP cold-start under one second.
- Does not write to user config: readConfig parses but never modifies $KIMI_CODE_HOME/config.toml.
- Does not write to Kimi agents/main/wire.jsonl — read-only via src/wire.js.

## Tests

Per-tool round-trips in tests/05-mcp-protocol.test.js. Cross-cutting helpers have focused unit tests: extract (09), embedding (07, 18), decay (10), ACL/validation (14, 29), search math (24), hooks (04, 15), CLI (12, 19). New modules land a focused test file before MCP surfacing.
