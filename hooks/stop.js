#!/usr/bin/env node
// Hook entry: Stop. Triggers an incremental archive ingest.
process.env.PM_HOOK_EVENT = 'Stop';
await import('../src/hooks/run.js');
