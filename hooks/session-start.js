#!/usr/bin/env node
// Hook entry: SessionStart. Dispatches to the shared runner.
process.env.KM_HOOK_EVENT = 'SessionStart';
await import('../src/hooks/run.js');
