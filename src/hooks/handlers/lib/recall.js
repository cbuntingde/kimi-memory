// Recall query construction, ranking, and score-gap filtering.
//
// The composite recall query for a UserPromptSubmit is assembled from
// four cue sources (prompt tokens, working-memory slots, the last
// session-focus title, recent tool-call file paths), searched against
// both DBs, then trimmed with a pool-aware per-DB limit and a
// score-gap elbow before the top hits are diversified by type.

import {
  searchMemories,
  listWorkingMemory,
  memoryCounts,
  reinforceIfStale,
} from '../../../persist.js';
import { GLOBAL_PROJECT_KEY } from '../../../project-key.js';
import { readLatestSessionFocus } from '../../../session-focus.js';
import { PATH_REGEX, firstContentLine } from '../../../util.js';
import {
  PROMPT_TOKEN_LIMIT,
  RECALL_BASE_LIMIT,
  RECALL_MIN_HITS,
  RECALL_GAP_FACTOR,
} from './constants.js';
import { pluralize } from './payload.js';

// Score-gap elbow. Pure helper so the gap filter is unit-testable
// without going through the full FTS+embedding pipeline (where
// producing a clean score gap is fragile). Given an array of hits
// with `id` and `score` fields, returns a new array containing only
// hits whose score is >= `topScore * factor`. `factor = 0` disables
// the filter (returns the input unchanged). `factor` is clamped to
// [0, 1] so a typo'd config can't produce weird results.
export function applyScoreGapFilter(hits, factor) {
  if (!Array.isArray(hits) || hits.length <= 1) return hits;
  const f = Math.max(0, Math.min(1, Number(factor) || 0));
  if (f === 0) return hits;
  // Use `.toSorted()` (Node 24+) so the input array is not mutated.
  const sorted = hits.toSorted((a, b) => (b.score || 0) - (a.score || 0));
  const topScore = sorted[0].score || 0;
  const elbow = topScore * f;
  const keep = new Set();
  for (const m of sorted) {
    if ((m.score || 0) >= elbow) keep.add(m.id);
  }
  return hits.filter((m) => keep.has(m.id));
}
export function derivePromptTokens(prompt) {
  if (!prompt) return [];
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32);
  return tokens.slice(0, PROMPT_TOKEN_LIMIT);
}

// ---- Recall: composite query builder + diversifier ----

// Build the composite recall query for a UserPromptSubmit. The legacy
// behaviour used prompt tokens only; v9 adds three more sources so
// recall picks up cues the prompt alone would miss: prompt tokens,
// working-memory slot values, last session-focus title, recent file
// paths from tool-call events.
//
// Tokens are de-duplicated case-insensitively. The result is a single
// space-joined string that the existing searchMemories() consumes as
// if it were a normal query.
export function buildRecallQuery({ prompt, workingSlots, focusRow, recentFiles }) {
  const seen = new Set();
  const tokens = [];
  const push = (text) => {
    if (!text) return;
    for (const t of derivePromptTokens(text)) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(t);
    }
  };
  push(prompt);
  if (Array.isArray(workingSlots)) {
    for (const slot of workingSlots) {
      push(slot && slot.value);
    }
  }
  if (focusRow && focusRow.title) push(focusRow.title);
  if (Array.isArray(recentFiles)) {
    for (const p of recentFiles) push(p);
  }
  // Cap at 24 to keep the FTS MATCH expression bounded. The
  // underlying searchMemories() also caps at 16 — any further tokens
  // are silently dropped.
  return tokens.slice(0, 24).join(' ');
}

// Pull the last N distinct file paths from conversation_events of
// kind='tool_call'. Used to bias the recall query toward path-tagged
// memories when the agent is editing files.
//
// Cheap; reads at most LIMIT rows from the index on
// (session_id, project_key, role). Returns basenames + their parent
// directory tokens so path-based memories match.
export function readRecentFilePaths(projectDb, projectKey, { limit = 5 } = {}) {
  if (!projectDb) return [];
  const TOOL_PAYLOAD_LIMIT = 64 * 1024;
  const MAX_PATHS_PER_ROW = 16;
  let rows;
  try {
    rows = projectDb
      .prepare(
        `SELECT substr(payload, 1, ?) AS payload
         FROM conversation_events
         WHERE project_key = ? AND kind = 'tool_call'
         ORDER BY line_no DESC LIMIT ?`,
      )
      .all(TOOL_PAYLOAD_LIMIT, projectKey, limit);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const pathRegex = PATH_REGEX;
  for (const r of rows) {
    if (!r.payload) continue;
    let text = r.payload;
    if (text.length > TOOL_PAYLOAD_LIMIT) text = text.slice(0, TOOL_PAYLOAD_LIMIT);
    if (text.length > 0 && text[0] === '{') {
      try {
        const parsed = JSON.parse(text);
        text = JSON.stringify(parsed);
      } catch {
        /* keep raw text */
      }
    }
    const matches = (text.match(pathRegex) || []).slice(0, MAX_PATHS_PER_ROW);
    for (const m of matches) {
      const norm = m.replace(/\\/g, '/').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(m.replace(/\\/g, '/'));
      const parts = m.replace(/\\/g, '/').split('/').filter(Boolean);
      const tail = parts.slice(-2).join('/');
      if (tail && !seen.has(tail.toLowerCase())) {
        seen.add(tail.toLowerCase());
        out.push(tail);
      }
      if (out.length >= limit * 2) break;
    }
    if (out.length >= limit * 2) break;
  }
  return out;
}

// Round-robin diversify a hit list so the top 3 the user sees spans
// multiple memory types. Without this a single high-confidence row
// can crowd out the rest; with it, the agent sees a mix of
// conventions, procedures, working notes, and conclusions.
export function diversifyHitsByType(hits, { topN = 3 } = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const byType = new Map();
  for (const h of hits) {
    const t = h.type || 'unknown';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(h);
  }
  for (const arr of byType.values()) {
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const picks = [];
  const types = [...byType.keys()];
  let i = 0;
  while (picks.length < topN && i < 64) {
    let added = false;
    for (const t of types) {
      if (picks.length >= topN) break;
      const arr = byType.get(t);
      if (!arr || arr.length === 0) continue;
      const next = arr.shift();
      if (next) {
        picks.push(next);
        added = true;
      }
    }
    if (!added) break;
    i += 1;
  }
  return picks;
}

export async function buildRecallSummary({ projectDb, globalDb, key, prompt }) {
  const workingSlots = projectDb ? listWorkingMemory(projectDb, key) : [];
  const focusRow = projectDb ? readLatestSessionFocus(projectDb, key) : null;
  const recentFiles = readRecentFilePaths(projectDb, key, { limit: 5 });
  const query = buildRecallQuery({ prompt, workingSlots, focusRow, recentFiles });
  if (!query || !query.trim()) {
    return {
      summary: null,
      projectHits: [],
      globalHits: [],
      recallLines: [],
      perTypeCounts: {},
      query: '',
      topHits: [],
    };
  }
  // (Audit fix — recall always returned 8 hits once a project had 8+
  // memories.) Pool-aware per-DB limit + score-gap elbow. The previous
  // behaviour was a hard `8` per DB regardless of how many memories
  // the project actually had, so an 8-memory project surfaced 8 hits
  // on every prompt even when only 1 was actually relevant. The new
  // shape:
  //   - Cap per DB at `RECALL_BASE_LIMIT` (the previous default).
  //   - For small pools, lower the cap so we don't surface ~75% of
  //     every saved memory on every prompt — `ceil(poolSize / 2)`,
  //     with a `RECALL_MIN_HITS` floor so a project with one memory
  //     still gets surfaced (it's the only thing to show).
  //   - The cap is the SQL `limit` so we don't even read the padding
  //     rows off disk. The gap filter (top-N by score elbow) trims
  //     the tail further once search returns.
  const projectActive = projectDb ? memoryCounts(projectDb, key).active || 0 : 0;
  const globalActive = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY).active || 0 : 0;
  // poolSize is the denominator for the `Recalled N of M.` summary
  // line so the user sees how representative the hits are. 0 on a
  // fresh install (neither DB exists).
  const poolSize = projectActive + globalActive;
  const projectLimit = Math.max(
    RECALL_MIN_HITS,
    Math.min(RECALL_BASE_LIMIT, Math.ceil(projectActive / 2)),
  );
  const globalLimit = Math.max(
    RECALL_MIN_HITS,
    Math.min(RECALL_BASE_LIMIT, Math.ceil(globalActive / 2)),
  );

  const rawProjectHits = projectDb
    ? await searchMemories(projectDb, key, query, {
        limit: projectLimit,
        perType: true,
        includeScore: true,
      })
    : [];
  const rawGlobalHits = globalDb
    ? await searchMemories(globalDb, GLOBAL_PROJECT_KEY, query, {
        limit: globalLimit,
        perType: true,
        includeScore: true,
      })
    : [];

  // Score-gap elbow. After per-type bucketing has produced the
  // balanced candidate list, drop any hit whose RRF score is below
  // `topScore * RECALL_GAP_FACTOR`. The intuition: a hit at <40% of
  // the top hit's relevance is probably a noisy keyword/embedding
  // match, not a real connection the agent should surface. Disabled
  // when factor = 0 (tests + opt-out escape hatch). See
  // `applyScoreGapFilter` for the pure helper + test coverage.
  let projectHits = rawProjectHits;
  let globalHits = rawGlobalHits;
  if (RECALL_GAP_FACTOR > 0 && rawProjectHits.length + rawGlobalHits.length > 1) {
    const allRaw = [...rawProjectHits, ...rawGlobalHits];
    const trimmedAll = applyScoreGapFilter(allRaw, RECALL_GAP_FACTOR);
    const keep = new Set(trimmedAll.map((m) => m.id));
    projectHits = rawProjectHits.filter((m) => keep.has(m.id));
    globalHits = rawGlobalHits.filter((m) => keep.has(m.id));
  }

  const allHits = [...projectHits, ...globalHits];
  const total = allHits.length;

  const perTypeCounts = {};
  for (const m of allHits) perTypeCounts[m.type] = (perTypeCounts[m.type] || 0) + 1;

  let summary;
  if (total === 0) {
    summary = 'No recall hits.';
  } else {
    const parts = [];
    if (projectHits.length) parts.push(`${projectHits.length} project`);
    if (globalHits.length) parts.push(`${globalHits.length} global`);
    const typeParts = Object.entries(perTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}: ${n}`);
    const typeStr = typeParts.length ? ` [${typeParts.join(', ')}]` : '';
    const ofTotal = poolSize > 0 ? ` of ${poolSize}` : '';
    summary =
      `Recalled ${pluralize(total, 'memory', 'memories')}${ofTotal}. (${parts.join(', ')}.) ${typeStr}`.trim();
  }
  const projectIdSet = new Set(projectHits.map((m) => m.id));
  const orderedForDiversify = [
    ...projectHits.sort((a, b) => (b.score || 0) - (a.score || 0)),
    ...globalHits.sort((a, b) => (b.score || 0) - (a.score || 0)),
  ];
  const topHits = diversifyHitsByType(orderedForDiversify, { topN: 3 });
  const recallLines = [];
  for (let i = 0; i < topHits.length; i++) {
    const m = topHits[i];
    const scope = projectIdSet.has(m.id) ? 'project' : 'global';
    const raw = (m.title || '').trim() || (m.content || '').slice(0, 80);
    const truncated = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    const score = m.score != null ? `, score=${m.score.toFixed(2)}` : '';
    const snippet = firstContentLine(m.content);
    const tail = snippet ? ` — ${snippet}` : '';
    recallLines.push(
      `[recall: ${i + 1}/${total}] "${truncated}" (${m.type}, ${scope}${score})${tail}`,
    );
  }

  if (projectDb && topHits.length > 0) {
    const top = topHits[0];
    if (top && top.id && projectIdSet.has(top.id)) {
      try {
        reinforceIfStale(projectDb, key, top.id);
      } catch {
        /* swallow — the recall surfaced fine even if reinforce failed */
      }
    }
  }

  const annotatedTopHits = topHits.map((m) => ({
    id: m.id,
    type: m.type,
    title: (m.title || '').trim() || (m.content || '').slice(0, 80),
    snippet: firstContentLine(m.content),
    score: m.score,
    scope: projectIdSet.has(m.id) ? 'project' : 'global',
  }));

  return {
    summary,
    projectHits,
    globalHits,
    recallLines,
    perTypeCounts,
    query,
    topHits: annotatedTopHits,
  };
}

// Build the AI-facing recall context for `hookSpecificOutput.additionalContext`.
// Returns null when there are no hits so the caller can skip the
// `additionalContext` field entirely.
export function buildRecallContextLines(recall, topHits) {
  if (!topHits || topHits.length === 0) return null;
  const total = recall.projectHits.length + recall.globalHits.length;
  const lines = [];
  lines.push(
    `[kimi-memory recall] ${total} memories surfaced — briefly acknowledge what you remember when relevant. If a memory is wrong or stale, say so and we can update it.`,
  );
  for (let i = 0; i < topHits.length; i++) {
    const m = topHits[i];
    const score = m.score != null ? `, score=${m.score.toFixed(2)}` : '';
    const tail = m.snippet ? ` — ${m.snippet}` : '';
    lines.push(`${i + 1}. (${m.type}, ${m.scope}${score}) "${m.title}"${tail}`);
  }
  return lines.join('\n');
}
