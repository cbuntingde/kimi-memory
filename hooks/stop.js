#!/usr/bin/env node
// Hook entry: Stop. Triggers an incremental archive ingest.
process.env.KM_HOOK_EVENT = 'Stop';
await import('../src/hooks/run.js');
