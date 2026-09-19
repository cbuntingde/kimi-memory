// Status / summary / thread / working-memory rendering for hook handlers.
//
// Every builder here produces a renderable string or list of lines
// from already-opened DB handles. Formatters for the status-line
// segments live in `format.js`; this module stitches them together
// with the counts and thread data the per-event handlers read.

import {
  listMemories,
  listWorkingMemory,
  listConversations,
  memoryCounts,
  loadIngestState,
  detectReclone,
  resetProject,
  wipeProjectLifecycleLogs,
} from '../../../persist.js';
import { deriveProjectKey, GLOBAL_PROJECT_KEY } from '../../../project-key.js';
import { formatFocusSegment } from '../../../session-focus.js';
import { truncate, firstContentLine } from '../../../util.js';
import {
  STATUS_RECENT_MEMORIES,
  STATUS_RECENT_WM_SLOTS,
  STATUS_RECENT_GLOBAL,
  MAX_THREAD_SESSIONS,
  HOME,
} from './constants.js';
import {
  formatConsolidateSegment,
  formatAutoGcSegment,
  formatIngestSegment,
  formatDreamSegment,
  formatExtractSegment,
  formatWorkLogSegment,
} from './format.js';
import { pluralize } from './payload.js';

export function buildCounts({ projectDb, globalDb, key }) {
  const project = projectDb ? memoryCounts(projectDb, key) : zeroCounts();
  const global = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY) : zeroCounts();
  const wm = projectDb ? listWorkingMemory(projectDb, key) : [];
  const conv = projectDb
    ? projectDb.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?').get(key).n
    : 0;
  const events = projectDb
    ? projectDb
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
        .get(key).n
    : 0;
  return { project, global, wm, conv, events };
}

export function zeroCounts() {
  return {
    total: 0,
    active: 0,
    retained: 0,
    expired: 0,
    superseded: 0,
    deleted: 0,
    by_type: {},
    by_status: {},
    latest_update_at: null,
  };
}

export function buildStatusLine({
  event,
  key,
  cwd,
  counts,
  ingest,
  recall,
  extract,
  workLog,
  focus,
  consolidate,
  autoGc,
  dream,
}) {
  const ingestSeg = formatIngestSegment(ingest);
  const recallSeg = recall ? ` recall project:${recall.project} global:${recall.global}` : '';
  const extractSeg = extract ? ` extract=${formatExtractSegment(extract)}` : '';
  const workLogSeg = workLog ? ` work_log=${formatWorkLogSegment(workLog)}` : '';
  const focusSeg = focus ? ` focus=${formatFocusSegment(focus)}` : '';
  const consolidateSeg = consolidate ? ` consolidate=${formatConsolidateSegment(consolidate)}` : '';
  const autoGcSeg = autoGc ? ` auto_gc=${formatAutoGcSegment(autoGc)}` : '';
  const dreamSeg = dream ? ` dream=${formatDreamSegment(dream)}` : '';
  return [
    `[kimi-memory] event=${event}`,
    `project_key=${key}`,
    `pmem.active=${counts.project.active}`,
    `gmem.active=${counts.global.active}`,
    `wm=${counts.wm.length}`,
    `conv=${counts.conv}`,
    `events=${counts.events}`,
    `ingest=${ingestSeg}${extractSeg}${workLogSeg}${focusSeg}${consolidateSeg}${autoGcSeg}${dreamSeg}${recallSeg}`,
    `cwd=${cwd}`,
  ].join(' ');
}

export function buildRecentSummary(projectDb, globalDb, key) {
  const projectRecent = projectDb
    ? listMemories(projectDb, key, { limit: STATUS_RECENT_MEMORIES })
    : [];
  const globalRecent = globalDb
    ? listMemories(globalDb, GLOBAL_PROJECT_KEY, { limit: STATUS_RECENT_GLOBAL })
    : [];
  const total = projectRecent.length + globalRecent.length;
  if (total === 0) return 'No recent memories.';
  const parts = [];
  if (projectRecent.length) parts.push(`${projectRecent.length} project`);
  if (globalRecent.length) parts.push(`${globalRecent.length} global`);
  return `Loaded ${pluralize(total, 'recent memory', 'recent memories')}. (${parts.join(', ')}.)`;
}

export function buildWorkingMemoryPreview(projectDb, key) {
  if (!projectDb) return [];
  const slots = listWorkingMemory(projectDb, key).slice(0, STATUS_RECENT_WM_SLOTS);
  return slots.map((s) => `- WM ${s.slot}: ${truncate(s.value, 200)}`);
}

// Re-clone detection: if the canonical project root was created after
// kimi-memory first stamped the per-project DB, the memories, working
// memory, and session archive belong to a previous incarnation of the
// repo. Surface a one-line warning so the user knows to call
// memory_reset_project before working on the new project.
//
// Auto-reset (default on, opt-out via KIMI_MEMORY_AUTO_RESET_ON_RECLONE=off):
// when detectReclone fires, wipe the project's per-row tables in a
// single transaction and report what was deleted. The reset itself
// is one-shot per re-clone event — resetProject updates first_seen_at
// to now, which neutralises detectReclone on the next SessionStart
// so subsequent sessions don't re-fire.
//
// Default on: most users who re-clone a repo want the prior
// incarnation's memories wiped, not silently carried forward. Set
// the env to `off` to keep the manual `[stale-memory]` hint instead.
export function buildStaleMemoryLine(projectDb, key, cwd) {
  if (!projectDb || !key || !cwd) return null;
  let r;
  try {
    r = detectReclone(projectDb, key, cwd);
  } catch {
    return null;
  }
  if (!r || !r.isReclone) return null;

  if (process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE === 'off') {
    return (
      `[stale-memory] ${cwd} appears to have been re-cloned after kimi-memory first saw it. ` +
      `Per-project memory (memories, working memory, session archive) belongs to the previous incarnation. ` +
      `Call memory_reset_project (with confirm=true) to start clean, or memory_status to see what's on file. ` +
      `Set KIMI_MEMORY_AUTO_RESET_ON_RECLONE=off to keep the manual hint instead of auto-wiping. ` +
      `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
    );
  }

  // Opt-in auto-reset path. Wrapped in try/catch so any wipe failure
  // falls back to the manual hint rather than crashing the session.
  let summary;
  let lifecycle;
  try {
    summary = resetProject(projectDb, key, { canonicalRoot: cwd });
    lifecycle = wipeProjectLifecycleLogs(projectDb, key);
  } catch (e) {
    return (
      `[stale-memory:auto-reset-failed] ${cwd} re-clone detected but reset failed: ` +
      `${e && e.message ? e.message : String(e)}. ` +
      `Call memory_reset_project (with confirm=true) to start clean. ` +
      `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
    );
  }
  const total =
    (summary.memories_deleted || 0) +
    (summary.working_memory_deleted || 0) +
    (summary.conversations_deleted || 0) +
    (summary.conversation_events_deleted || 0) +
    (summary.memory_edges_deleted || 0) +
    (summary.memory_synthesizes_deleted || 0) +
    (lifecycle.dream_jobs_deleted || 0) +
    (lifecycle.dream_proposals_deleted || 0) +
    (lifecycle.consolidation_runs_deleted || 0);
  return (
    `[stale-memory:auto-reset] ${cwd} re-cloned; wiped ${total} per-project rows ` +
    `(memories:${summary.memories_deleted} wm:${summary.working_memory_deleted} ` +
    `sessions:${summary.conversations_deleted}/events:${summary.conversation_events_deleted} ` +
    `edges:${summary.memory_edges_deleted} synth:${summary.memory_synthesizes_deleted} ` +
    `dreams:${lifecycle.dream_jobs_deleted}/${lifecycle.dream_proposals_deleted} ` +
    `consolidation:${lifecycle.consolidation_runs_deleted}). Next session starts at 0. ` +
    `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
  );
}

// Build a "[thread]" line listing the last few distinct sessions
// for the project. Returns null when the project has fewer than 2
// sessions on file.
export function buildSessionThread(projectDb, projectKey) {
  if (!projectDb) return null;
  let conversations;
  try {
    conversations = listConversations(projectDb, projectKey, { limit: MAX_THREAD_SESSIONS });
  } catch {
    return null;
  }
  if (!conversations || conversations.length < 2) return null;

  const lines = [];
  const ordered = [...conversations].reverse();
  lines.push(`[thread] (${ordered.length} sessions, oldest → newest)`);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    let focus = null;
    try {
      focus = projectDb
        .prepare(
          `SELECT id, title, content, session_id, is_session_focus FROM memories
           WHERE project_key = ? AND status = 'active' AND type = 'working'
             AND is_session_focus = 1 AND (session_id = ? OR session_id IS NULL)
           ORDER BY (session_id = ?) DESC, datetime(updated_at) DESC LIMIT 1`,
        )
        .get(projectKey, c.session_id, c.session_id);
    } catch {
      /* ignore — fall back to the title only */
    }
    const title = (focus && focus.title) || `Session ${i + 1}`;
    const snippet = firstContentLine((focus && focus.content) || '');
    const tail = snippet ? ` — ${snippet}` : '';
    lines.push(`[thread: ${i + 1}/${ordered.length}] "${truncate(title, 80)}"${tail}`);
  }
  return lines;
}

// Read the most recently persisted extract + work-log + session-focus
// stats for this project. Returns nulls for fields that have never
// been written.
export async function readLatestStats(cwd) {
  if (!cwd) return { extract: null, workLog: null, focus: null };
  try {
    const key = deriveProjectKey(cwd);
    const state = await loadIngestState(HOME, key);
    return {
      extract: state.latest_extract || null,
      workLog: state.latest_work_log || null,
      focus: state.latest_session_focus || null,
    };
  } catch {
    return { extract: null, workLog: null, focus: null };
  }
}

// ---- Stdout emitter ----

export function emitLines(lines) {
  if (!lines || lines.length === 0) return;
  try {
    process.stdout.write(lines.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}
