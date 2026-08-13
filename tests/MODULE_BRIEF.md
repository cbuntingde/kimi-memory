---
module: tests
last_verified: 2026-08-13
---

# tests

## Summary

Test suite. 34 numbered test files (01..33 with a deliberate duplicate file at 22 — 22-brain-modes.test.js and 22-reset-project.test.js — from a rename) plus tests/_helpers.js. Format is NN-topic.test.js, run via node --test --test-reporter=spec tests/_.test.js. Coverage is per-tool and per-pass, not by line threshold: every public MCP tool has either a focused unit test or an MCP round-trip in tests/05-mcp-protocol.test.js; every new background pass (auto-GC, decay, consolidate, embed-retry) drives the pass against a synthetic DB end-to-end. Tests run on a mkTempHome-style isolation: each file owns its own DB under /tmp/pm-test-_.

## Public API

- _helpers.js exports mkTempHome(prefix?), rmRf(dir), writeJsonl(file, lines), writeRaw(file, text), readText(file), exists(file), stat(file), pluginRoot(), StdioMcp class (start(), stop(), call(method, params), toolCall(name, args), onNotification).
- _helpers.js sets process.env.KIMI_MEMORY_EMBEDDINGS = off at import time when the env var is unset, so embedding math is bypassed by default; tests that exercise it explicitly set the env var to on before importing.
- Per-tool test files: 02-persist, 03-wire, 04-hooks, 05-mcp-protocol, 06-manifest, 07-embedding, 08-edges, 09-extract, 10-decay, 11-conclusions, 12-prune, 13-recall-per-type, 14-secret-block, 17-work-log, 18-embedding-integration, 19-cli-export-import, 20-embed-retry, 21-comprehensive-improvements, 22-brain-modes, 22-reset-project, 23-session-focus, 24-rrf-scoring, 25-skills, 26-codegraph, 27-tools-lazy, 28-pipeline-status, 29-visibility-acl, 30-redact-secrets, 31-row-corruption, 32-batch2-fixes, 33-auto-gc-smoke.
- Gated tests: tests/16-perf.test.js runs only when KIMI_MEMORY_PERF=on; tests/15-hook-stress.test.js runs when KIMI_MEMORY_HOOK_STRESS=on.

## Data shape

Common shape: each test sets up a mkTempHome-backed project, runs a focused operation, asserts on the visible result, and rmRfs the temp dir in a try/finally so partial failures do not leak disk. MCP round-trips spawn the server via StdioMcp (stdio JSON-RPC) — no mocks of the wire.

## Failure modes

- A flaky test under high concurrency (typically tests/15-hook-stress.test.js): marked as such and gated by an env var so the default npm test run is deterministic.
- Embedding-related tests that forget to set KIMI_MEMORY_EMBEDDINGS=on: hang on the 25 MB model download. The default in _helpers.js is off; tests that need the model set the env var explicitly.

## Boundaries

- Tests read the real code under src/, no mocks. The only mocked surface is the embedding env-var boundary — by configuration, not by stubbing the encoder.
- Tests never write to the user real $KIMI_CODE_HOME. StdioMcp accepts a home argument and sets KIMI_CODE_HOME=<home> in the child env.

## Tests

Self-evident. Run with npm test. Add a new focused file tests/NN-name.test.js whenever a new module or new MCP tool ships; round-trip the new tool in tests/05-mcp-protocol.test.js when the surface changes; add a smoke test for every new background pass (auto-GC, decay, consolidate).
