// Advisor subsystem: cheap keyword detection for advisor-style prompts.
//
// Lives inside the kimi-memory plugin (was the standalone kimi-advisor
// plugin before the 2026-07-31 merge). All branches fail open: any
// uncaught error is logged to a diagnostics file and the process
// exits 0 so Kimi's lifecycle is never blocked.
//
// Used by src/hooks/run.js on UserPromptSubmit. Not invoked on
// SessionStart — the advisor skill is loaded on demand via /advisor
// or by the agent when it recognises the keyword from this hook's
// status line.

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';

// Frozen keyword list. Case-insensitive substring match.
// Keep this list and skills/advisor/SKILL.md's "Triggers" section in sync.
export const ADVISOR_KEYWORDS = Object.freeze([
  'would we change',
  'what would you do differently',
  'what would we do differently',
  'how can we improve',
  'how would you improve',
  'what are we missing',
  'is there a better way',
  "anything you'd change",
  'anything you would change',
  'review this approach',
  'second opinion',
  'how would you approach',
  'what would you change',
  'do anything different',
  'do differently',
]);

// Synchronous, bounded, best-effort log writer. Failures here are
// swallowed — diagnostics are never allowed to block the hook.
export function logAdvisorDiag(message) {
  try {
    // import.meta.dirname -> .../plugins/managed/kimi-memory/src/advisor/
    const pluginRoot = path.resolve(import.meta.dirname, '..', '..');
    const dir = path.join(pluginRoot, '_diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'advisor-hooks.log'),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    // swallow — diagnostics are best-effort
  }
}

// Case-insensitive substring match against ADVISOR_KEYWORDS.
// Returns the matched keyword or null. Pure; safe to call on every prompt.
export function matchAdvisor(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const lower = prompt.toLowerCase();
  for (const kw of ADVISOR_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}
