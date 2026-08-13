---
module: src/hooks
last_verified: 2026-08-13
---

# src/hooks

## Summary

Internal hook runner. Three files. run.js (1560 lines) is the unified dispatcher: reads stdin JSON, dispatches on KM_HOOK_EVENT, runs SessionStart/UserPromptSubmit/Stop/SessionEnd/PreCompact/Interrupt/StopFailure/PostToolUse handlers, emits the bounded status line plus hookSpecificOutput.additionalContext. tool-recall.js is the PostToolUse mid-turn recall (runToolRecall, formatToolRecallLines, extractQueryFromToolArgs) — pure, no LLM, fail-open. embed-retry.js is the SessionStart-time retry pass for rows whose embedding write failed 24+ hours ago.

## Public API

- run.js — top-level dispatcher (executed when KM_HOOK_EVENT is set). Exports the pure helpers buildRecallQuery, diversifyHitsByType, readRecentFilePaths, buildSessionThread, formatConsolidateSegment, formatAutoGcSegment, formatIngestSegment, formatExtractSegment, formatWorkLogSegment, buildSessionFocusLine, formatFocusSegment for tests.
- tool-recall.js — runToolRecall({projectDb, globalDb, projectKey, toolArgs, limit?}) returns {lines, hits}. formatToolRecallLines(result) returns the line array. extractQueryFromToolArgs(args) is the pure query extractor used by both runToolRecall and tests.
- embed-retry.js — retryFailedEmbeddings(db, projectKey) returns {scanned, retried, recovered, failed}. Bounded to RETRY_MAX_ROWS=5 candidates per call. Run from SessionStart after the decay pass.

## Data shape

run.js is internally segmented: payload-projection helpers (payloadProjectRoot/payloadSessionId/payloadPrompt), recall query construction (buildRecallQuery, derivePromptTokens), status-line builders (buildStatusLine, formatConsolidateSegment, …), and per-event handlers (handleSessionStart, handleUserPromptSubmit, handleStop, …). Each handler is wrapped in try/catch so the dispatcher main() never throws.

## Failure modes

- Any handler throw → logged via logDiag error handler threw, then process.stdout.write [kimi-memory] hook event failed, then exit 0. Hook never blocks the lifecycle.
- Eight second wall-clock guard: setTimeout(…, 8000) with .unref() shuts down the SQLite handle and exits 0 if the pipeline does not unwind (e.g., mid-write on a hung DB).
- runToolRecall swallowing: a DB error in either project or global scope is caught and returns empty hits without throwing — the PostToolUse event keeps running.

## Boundaries

- Does not import any node:sqlite internals — all DB access goes through src/persist.js helpers.
- Does not write to the diagnostics file directly — every log goes through src/diagnostics.js.
- Does not own the schema. The runner calls into persist; migrations are owned by persist/connection.js.

## Tests

tests/04-hooks.test.js — recall surface, status line shape, advisor keyword detection, working-memory preview, re-clone warning. tests/15-hook-stress.test.js — concurrency, throttling, repeated-prompt debounce. tests/20-embed-retry.test.js — 24h age gate, RETRY_MAX_ROWS cap, success and failure paths. tests/22-brain-modes.test.js — pulls the pure helpers (buildRecallQuery, etc.) directly. tests/23-session-focus.test.js — focus capture and emission.
