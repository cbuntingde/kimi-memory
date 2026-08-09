// Mid-turn recall: when the agent invokes a tool, this module
// surfaces relevant stored memories on stdout before the model
// continues. Two cheap triggers:
//
//   1. File-path trigger — the tool's arguments mention a path that
//      matches a memory's tags or content (e.g. the agent edits
//      src/hooks/run.js, and a stored convention references that
//      file).
//   2. Command trigger — the tool's arguments contain a shell verb
//      that matches a memory's title or tags (e.g. `pnpm test`
//      triggers a build/test memory).
//
// Fail-open by design. No LLM call; pure token match + FTS5 query.
// Up to TOOL_RECALL_MAX lines are emitted per hook call.
//
// Hook surface: this module is invoked from run.js on the
// PostToolUse event. Some Kimi versions may not declare that event;
// in that case the handler is silently never invoked and the plugin
// degrades gracefully.

import { searchMemories } from '../persist.js';
import { PATH_REGEX, SHELL_VERB_REGEX } from '../util.js';

const TOOL_RECALL_MAX = 2;
// Score floor for a tool-recall hit. Default `minScore=0.01` matches
// the persist layer's `MIN_RELEVANCE_SCORE` — rank-1 hits with RRF_K=60
// score 1/61 ≈ 0.0164, so a higher floor would silently suppress every
// surface. Mid-turn recall is best-effort; a too-aggressive floor
// defeats the point. Pass `minScore` in opts to override.
const TOOL_RECALL_MIN_SCORE = 0.01;

// Extract a query string from a tool-call payload. The Kimi wire
// payload may be a JSON object (file_path, command, content…) or a
// raw string. We try to be permissive: tokenise whatever looks like
// a path or command verb.
//
// IMPORTANT: the resulting query is consumed by FTS5, which AND-joins
// every token by default. If we feed it a full path like
// "C:/code/proj/src/hooks/run.js", the FTS search would require
// every segment (c, code, proj, src, hooks, run, js) to appear in
// the row's FTS text. That almost never matches. So we deliberately
// drop the *full path* token (it's redundant given the tail segments)
// and keep only the basename + parent directory + shell verbs. The
// caller still gets high-signal queries; the FTS5 AND-explosion goes
// away.
function extractQueryFromToolArgs(args) {
  if (!args) return '';
  let text = typeof args === 'string' ? args : JSON.stringify(args);
  if (text.length > 4000) text = text.slice(0, 4000);
  const parts = [];
  const paths = text.match(PATH_REGEX) || [];
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/');
    const segments = norm.split('/').filter(Boolean);
    // Drop file extensions from the basename so FTS5 doesn't AND-join
    // a token like "js" against every segment in the path. Memory
    // rows rarely contain the extension; they do contain the stem.
    const stripExt = (s) => s.replace(/\.[a-z0-9]{1,8}$/i, '');
    if (segments.length >= 2) {
      parts.push(
        stripExt(segments[segments.length - 2]) + '/' + stripExt(segments[segments.length - 1]),
      );
    }
    if (segments.length >= 1) {
      parts.push(stripExt(segments[segments.length - 1]));
    }
  }
  const verbs = text.match(SHELL_VERB_REGEX) || [];
  for (const v of verbs) parts.push(v);
  // De-dupe, case-insensitive.
  const seen = new Set();
  const out = [];
  for (const t of parts) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 12).join(' ');
}

// Render a hit as a `[tool-recall]` line. Mirrors the [recall: i/N]
// shape so the agent's parser already knows what to do with it.
function formatHit(memory, { index, total, scope }) {
  const title = (memory.title || '').trim() || (memory.content || '').slice(0, 80);
  const truncated = title.length > 80 ? title.slice(0, 80) + '…' : title;
  const score = memory.score != null ? `, score=${memory.score.toFixed(2)}` : '';
  const snippet = firstLineSnippet(memory.content);
  const tail = snippet ? ` — ${snippet}` : '';
  return `[tool-recall: ${index + 1}/${total}] "${truncated}" (${memory.type}, ${scope}${score})${tail}`;
}

function firstLineSnippet(content) {
  if (!content) return '';
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!first) return '';
  return first.length > 120 ? first.slice(0, 120) + '…' : first;
}

// Top-level: query each scope with the extracted query, deduplicate
// against the agent's already-loaded context (no-op here — the agent
// filters on read), and return the formatted lines.
//
// Returns { lines, hits }. Both are best-effort: a DB error returns
// an empty result without throwing.
export async function runToolRecall({
  projectDb,
  globalDb,
  projectKey,
  toolArgs,
  globalProjectKey = '_global',
  limit = TOOL_RECALL_MAX,
} = {}) {
  const query = extractQueryFromToolArgs(toolArgs);
  if (!query || !query.trim()) return { lines: [], hits: [] };
  const opts = {
    limit: Math.max(1, Math.min(10, limit)),
    perType: true,
    includeScore: true,
    minScore: TOOL_RECALL_MIN_SCORE,
  };
  let projectHits = [];
  let globalHits = [];
  try {
    if (projectDb) {
      projectHits = await searchMemories(projectDb, projectKey, query, opts);
    }
  } catch {
    projectHits = [];
  }
  try {
    if (globalDb) {
      globalHits = await searchMemories(globalDb, globalProjectKey, query, opts);
    }
  } catch {
    globalHits = [];
  }
  // Project first, then global — same ordering as UserPromptSubmit.
  const all = [...projectHits, ...globalHits];
  if (all.length === 0) return { lines: [], hits: [] };
  // Diversify lightly: skip duplicates of the same title across scopes.
  const seen = new Set();
  const deduped = [];
  for (const h of all) {
    const key = (h.title || h.id || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
    if (deduped.length >= limit) break;
  }
  const projectIdSet = new Set(projectHits.map((m) => m.id));
  const lines = deduped.map((h, i) =>
    formatHit(h, {
      index: i,
      total: deduped.length,
      scope: projectIdSet.has(h.id) ? 'project' : 'global',
    }),
  );
  return { lines, hits: deduped };
}

// Convenience formatter for callers that just want the lines.
export function formatToolRecallLines(result) {
  if (!result || !Array.isArray(result.lines)) return [];
  return result.lines;
}

// Exposed for tests: the query extractor is a pure function.
export { extractQueryFromToolArgs };
