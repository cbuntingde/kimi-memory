#!/usr/bin/env node
// Hook entry: PreCompact. Runs idempotent session-archive ingest so the
// transcript is captured before the context window is compacted.
process.env.PM_HOOK_EVENT = 'PreCompact';
await import('../src/hooks/run.js');
