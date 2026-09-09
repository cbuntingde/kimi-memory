#!/usr/bin/env node
process.env.KM_HOOK_EVENT = 'PostToolUseFailure';
await import('../src/hooks/run.js');
