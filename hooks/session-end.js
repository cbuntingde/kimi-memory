#!/usr/bin/env node
// Hook entry: SessionEnd. Best-effort final ingest.
process.env.KM_HOOK_EVENT = 'SessionEnd';
await import('../src/hooks/run.js');
