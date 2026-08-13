---
module: hooks
last_verified: 2026-08-13
---

# hooks

## Summary

Eight one-shot Node entry points (session-start, user-prompt-submit, stop, session-end, pre-compact, interrupt, stop-failure, post-tool-use). Each is a 4-line shim that sets `process.env.KM_HOOK_EVENT` and `await import("../src/hooks/run.js")`. Kimi dispatches each lifecycle event into its own script; the shim forwards to the single shared runner. Files are intentionally trivial so Kimi hook-installer has minimal surface to enumerate.

## Public API

- process.env.KM_HOOK_EVENT — set per-script; the single signal the shared runner dispatches on.
- Each script reads one JSON hook payload from stdin; writes one bounded status line + optional `hookSpecificOutput.additionalContext` JSON on stdout.
- Exit code is always 0; failures land on `_diagnostics/hooks.log` and stderr `[kimi-memory:hook:<event>]`, never as a non-zero status.

## Data shape

Each script reads a JSON object `{cwd, session_id, prompt?, …}` from stdin and writes one bounded status line + optional additionalContext to stdout. Failures land on stderr prefixed `[kimi-memory:hook:<event>]`. The payload is forwarded to src/hooks/run.js unchanged.

## Failure modes

- A runner crash must NOT propagate as a non-zero exit. The runner wraps every handler in try/catch and exits 0; the only non-zero exit path is SIGKILL from Kimi hook timeout.
- Read timeout: bounded by the SDK hook-level timeout (8 s wall). The runner installs a defensive setTimeout that exits cleanly at 8 s.

## Boundaries

- Does not embed the embedding model, the LLM call, or the FTS index directly — those live in src/{embedding,extract,persist}.js.
- Does not write to `<pluginRoot>/_diagnostics/hooks.log` — the log lives in `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log` via src/diagnostics.js.
- Does not touch `agents/main/wire.jsonl` — read-only access via src/wire.js.

## Tests

End-to-end coverage in tests/04-hooks.test.js (recall surface, status line shape, advisor match, working-memory preview, re-clone warning) and tests/15-hook-stress.test.js (concurrent runs, throttling). Each individual shim is exercised by the spawn-and-read harness in those suites; no per-script unit tests because the bodies are trivial.
