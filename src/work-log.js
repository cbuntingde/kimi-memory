// Daily project work-log auto-writer.
//
// Goal: every project in kimi-memory gets a deterministic, date-titled
// episodic memory per UTC day that captures what actually happened in
// code (commits), how much activity there was (event/session counts),
// and which durable memories the user already saved that day. Idempotent
// within the day — re-running the hook just updates the same memory
// rather than spawning duplicates.
//
// Why deterministic (no LLM call):
//   - The LLM-driven `extract` path already runs at every Stop and can
//     write semantic/procedural facts. A second LLM call here would be
//     duplicate cost for marginal benefit.
//   - The work-log is a recall anchor, not a narrative: "what did we
//     do on 2026-08-02" → list of commits + active memory titles is
//     more useful than a model-written summary that might hallucinate.
//
// Trigger thresholds (in run.js's handleAutoExtract flow):
//   - At least one of:
//       (a) ≥ WORK_LOG_MIN_EVENTS conversation events for the project,
//           today (UTC); OR
//       (b) ≥ 1 git commit with the project's cwd as a top-level path,
//           since 00:00 UTC today.
//   - Below threshold → no-op. The hook runs cleanly every Stop, but
//     a project with no activity shouldn't get an empty work-log.
//
// Idempotency: titles are prefixed `YYYY-MM-DD · <project> work log`.
// The writer uses `supersede: true` on save so the prior day's entry
// at the same title is marked superseded and the new content lands in
// its row — readers always see exactly one active work-log per day per
// project.
//
// Fail-open: every step is wrapped so a failing git call, DB error, or
// node:fs hiccup never throws out of the hook. The function returns
// `{ skipped: 'reason' | null, written: 0|1, updated: 0|1, reason }`.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { nowIso } from './util.js';

export const WORK_LOG_MIN_EVENTS = 8;

function todayUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Pick the most path-y segment of `cwd` for the human-readable project
// name in the work-log title. Falls back to the full canonical root if
// the segment is too generic. Example: `C:/Chris-Dev/axiom-cache` →
// `axiom-cache`.
export function deriveProjectDisplayName(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'project';
  const norm = cwd.replace(/[\\/]+$/, '');
  const last = norm.split(/[\\/]/).pop();
  if (!last || last.length < 2 || last === 'src' || last === 'app') return norm;
  return last;
}

export function workLogTitle(projectName, dayIso) {
  return `${dayIso} · ${projectName} work log`;
}

// Run `git log --since=00:00 UTC today` against `cwd` and return a
// compact list of `<short-hash> <subject>` lines. Returns [] on any
// failure (no git, no repo, non-zero exit) — the call is fail-open.
//
// `runGit` is an injection seam for tests; defaults to a real
// child_process call to `git`.
export function gatherCommits(cwd, dayIso, { runGit } = {}) {
  return new Promise((resolve) => {
    const since = `${dayIso}T00:00:00Z`;
    const exec = runGit || ((args, cb) => {
      execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => cb(err, stdout));
    });
    exec(
      [
        'log',
        '--since=' + since,
        '--pretty=format:%h %s',
        '--no-merges',
      ],
      (err, stdout) => {
        if (err || typeof stdout !== 'string') {
          resolve({ commits: [], error: 'git_failed' });
          return;
        }
        const lines = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve({ commits: lines, error: null });
      },
    );
  });
}

// Count conversation_events for `project_key` whose `created_at` falls
// on the given UTC day, and collect the set of distinct session IDs.
// Bounded SQL; cheap.
export function gatherTodaysActivity(db, projectKey, dayIso) {
  let row;
  try {
    row = db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s
         FROM conversation_events
         WHERE project_key = ?
           AND substr(created_at, 1, 10) = ?`,
      )
      .get(projectKey, dayIso);
  } catch {
    return { events: 0, sessions: 0, error: 'db_query_failed' };
  }
  return { events: (row && row.n) || 0, sessions: (row && row.s) || 0, error: null };
}

// List titles of memories updated today on this project. Used as a
// cross-ref so the work-log answers "what facts did I already save
// today" without making the agent run a separate recall.
export function gatherTodaysMemoryTitles(db, projectKey, dayIso) {
  try {
    const rows = db
      .prepare(
        `SELECT title FROM memories
         WHERE project_key = ?
           AND status = 'active'
           AND substr(updated_at, 1, 10) = ?
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all(projectKey, dayIso);
    return rows.map((r) => (r.title || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function buildWorkLogContent({ projectName, dayIso, commits, events, sessions, memoryTitles }) {
  const lines = [];
  lines.push(`Work log for ${projectName} on ${dayIso} (UTC).`);
  lines.push(
    `Sessions today: ${sessions}; conversation_events today: ${events}.`,
  );
  lines.push(`Commits today (${commits.length}):`);
  if (commits.length === 0) {
    lines.push('- (none)');
  } else {
    for (const c of commits.slice(0, 30)) lines.push(`- ${c}`);
    if (commits.length > 30) lines.push(`- …and ${commits.length - 30} more`);
  }
  lines.push('');
  lines.push(`Memories saved/updated today on this project (${memoryTitles.length}):`);
  if (memoryTitles.length === 0) {
    lines.push('- (none)');
  } else {
    for (const t of memoryTitles.slice(0, 30)) lines.push(`- ${t}`);
    if (memoryTitles.length > 30) lines.push(`- …and ${memoryTitles.length - 30} more`);
  }
  return lines.join('\n');
}

// Top-level orchestrator. Caller passes the persist-layer `saveMemory`
// so this module stays free of node:sqlite imports.
//
// Inputs:
//   - db: open SQLite handle for the project DB
//   - projectKey: the project's kimi-memory key
//   - cwd: canonical project root (used for git log + display name)
//   - injections for tests:
//       saveMemory (required)
//       now (returns Date, defaults to () => new Date())
//       runGit (defaults to real execFile git log)
//       isDisabled (env-driven; defaults to
//                   KIMI_MEMORY_DISABLE_WORK_LOG === '1')
//       minEvents (default WORK_LOG_MIN_EVENTS)
//
// Returns:
//   { skipped: string | null, written: 0|1, updated: 0|1, reason: string }
export async function maybeWriteWorkLog({
  db,
  projectKey,
  cwd,
  saveMemory,
  now = () => new Date(),
  runGit,
  isDisabled = () => process.env.KIMI_MEMORY_DISABLE_WORK_LOG === '1',
  minEvents = WORK_LOG_MIN_EVENTS,
}) {
  if (!db || !projectKey) {
    return { skipped: 'missing_db_or_key', written: 0, updated: 0, reason: null };
  }
  if (isDisabled()) {
    return { skipped: 'env_opt_out', written: 0, updated: 0, reason: null };
  }
  if (!saveMemory) {
    return { skipped: 'no_persist', written: 0, updated: 0, reason: null };
  }
  const dayIso = todayUtc(now());
  const projectName = deriveProjectDisplayName(cwd);
  const title = workLogTitle(projectName, dayIso);

  // Step 1: gather activity signals.
  const activity = gatherTodaysActivity(db, projectKey, dayIso);
  const { commits, error: gitErr } = cwd
    ? await gatherCommits(cwd, dayIso, { runGit })
    : { commits: [], error: 'no_cwd' };
  const memoryTitles = gatherTodaysMemoryTitles(db, projectKey, dayIso);

  // Threshold: enough events OR at least one commit.
  const enoughEvents = activity.events >= minEvents;
  const hasCommit = commits.length >= 1;
  if (!enoughEvents && !hasCommit) {
    return {
      skipped: 'below_threshold',
      written: 0,
      updated: 0,
      reason: `events=${activity.events} commits=${commits.length} min=${minEvents}`,
    };
  }

  // Step 2: build content + save with supersede=true so the prior row
  // at the same title (if any) is replaced instead of duplicated.
  const content = buildWorkLogContent({
    projectName,
    dayIso,
    commits,
    events: activity.events,
    sessions: activity.sessions,
    memoryTitles,
  });

  let saved;
  try {
    saved = saveMemory(db, projectKey, {
      type: 'episodic',
      title,
      content,
      tags: ['work-log', dayIso.slice(0, 7), projectName, 'auto'],
      confidence: 0.85,
      priority: 0,
      supersede: true,
      provenance: {
        source: 'work_log_auto',
        cwd: cwd || null,
        day: dayIso,
        events: activity.events,
        sessions: activity.sessions,
        commits: commits.length,
        git_error: gitErr || null,
        recorded_at: nowIso(),
      },
    });
  } catch (e) {
    return {
      skipped: 'save_failed',
      written: 0,
      updated: 0,
      reason: (e && e.message) || String(e),
    };
  }

  // saveMemory with supersede=true sets the new row's `supersedes`
  // column to the prior row's id (or null on a fresh day). One row
  // inserted per call; "updated" reports whether we replaced an
  // earlier entry for the same date.
  return {
    skipped: null,
    written: 1,
    updated: saved && saved.supersedes ? 1 : 0,
    reason: `events=${activity.events} commits=${commits.length}`,
    id: (saved && saved.id) || null,
  };
}

// Re-exportable for tests + observability: `lastWorkLogResult` is a
// simple in-process registry of the most recent run per project. The
// hook runner reads it to surface extract/work-log stats in the next
// UserPromptSubmit status line.
const _lastResultByKey = new Map();

export function recordWorkLogResult(projectKey, result) {
  if (!projectKey) return;
  _lastResultByKey.set(projectKey, { at: Date.now(), result });
}

export function takeLastWorkLogResult(projectKey) {
  if (!projectKey) return null;
  const v = _lastResultByKey.get(projectKey);
  return v || null;
}

export function _resetWorkLogRegistryForTests() {
  _lastResultByKey.clear();
}

// Suppress an unused-symbol warning when fs is imported for future
// enrichment. Kept so a future `readFile`-backed fallback (e.g. for
// repos with `--no-pager` issues) doesn't add an import.
void fs;
