#!/usr/bin/env node
// Hook entry: UserPromptSubmit.
process.env.PM_HOOK_EVENT = 'UserPromptSubmit';
await import('../src/hooks/run.js');
