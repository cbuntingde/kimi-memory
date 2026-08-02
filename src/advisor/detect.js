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

// Negation markers that suppress an advisor match. The substring
// detector fires on any sentence containing a keyword, which produces
// obvious false positives for "I wouldn't change anything", "we don't
// do it differently", "there's no better way", etc. The detector
// only accepts a match when the *sentence* around the keyword does
// not contain a negation marker. This keeps "do differently" matching
// "how could we do differently?" but rejects "we don't do it
// differently."
const NEGATION_PATTERN =
  /\b(?:don'?t|do\s+not|wouldn'?t|shouldn'?t|won'?t|can'?t|cannot|never|no\s+need|nothing|nowhere|nobody|nor|none|isn'?t|aren'?t|wasn'?t|weren'?t|hardly|barely|not\s+a|not\s+the|not\s+really|not\s+very|not\s+at\s+all)\b/i;

// Sentence splitter: returns the substring of `text` around `index`
// delimited by sentence terminators (`.`, `?`, `!`, `;`, `:`) and
// newlines. The `String.search` call returns the index of the first
// match (works for any regex flag combination); the previous
// implementation called `right.match(terminators)` and read
// `.index` on the returned array, which is `undefined` when the
// regex has the `g` flag (the array carries strings, not match
// objects) — that bug short-circuited the slice and the negation
// gate silently never fired. Use `search` so the index is
// always defined.
function sentenceOf(text, index) {
  const left = text.slice(0, index);
  const right = text.slice(index);
  const terminators = /[.?!;:\n]/;
  let start = 0;
  for (const m of left.matchAll(new RegExp(terminators.source, 'g'))) {
    start = m.index + 1;
  }
  const endIdx = right.search(terminators);
  const end = endIdx === -1 ? right.length : endIdx + 1;
  return text.slice(start, index + end).trim();
}

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

// Case-insensitive substring match against ADVISOR_KEYWORDS with a
// negation gate: a match is only returned when the sentence around
// the keyword does not contain a negation marker. Returns the matched
// keyword (the first one, in list order) or null. Pure; safe to call
// on every prompt.
export function matchAdvisor(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const lower = prompt.toLowerCase();
  for (const kw of ADVISOR_KEYWORDS) {
    const idx = lower.indexOf(kw);
    if (idx === -1) continue;
    const sentence = sentenceOf(lower, idx);
    if (NEGATION_PATTERN.test(sentence)) continue;
    return kw;
  }
  return null;
}

// Exposed for tests and diagnostics: a small introspection helper
// that returns every keyword whose match would be suppressed by a
// negation in the prompt. Used by the test suite to assert the
// negative-match list covers the common false-positive shapes.
export function _negatedMatches(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];
  const lower = prompt.toLowerCase();
  const out = [];
  for (const kw of ADVISOR_KEYWORDS) {
    const idx = lower.indexOf(kw);
    if (idx === -1) continue;
    const sentence = sentenceOf(lower, idx);
    if (NEGATION_PATTERN.test(sentence)) out.push(kw);
  }
  return out;
}
