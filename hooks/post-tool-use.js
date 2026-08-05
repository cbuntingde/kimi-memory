#!/usr/bin/env node
// Hook entry: PostToolUse. Triggers mid-turn recall based on the
// tool call's arguments (file paths, shell verbs). See
// src/hooks/tool-recall.js for the trigger logic.
process.env.KM_HOOK_EVENT = 'PostToolUse';
await import('../src/hooks/run.js');
