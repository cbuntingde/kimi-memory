#!/usr/bin/env node
// Hook entry: Interrupt. Runs idempotent session-archive ingest and
// records a diagnostic so an interrupted turn still gets archived.
process.env.PM_HOOK_EVENT = 'Interrupt';
await import('../src/hooks/run.js');
