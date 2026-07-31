#!/usr/bin/env node
// Hook entry: StopFailure. Runs idempotent session-archive ingest and
// records a diagnostic when an agent loop fails to stop cleanly.
process.env.KM_HOOK_EVENT = 'StopFailure';
await import('../src/hooks/run.js');
