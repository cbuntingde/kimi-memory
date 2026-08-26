// SessionStart handler. Boot-time: status line + decay + consolidate
// + auto-GC + opportunistic Dream apply + thread + working-memory
// preview + re-clone warning.

import path from 'node:path';
import { ensureProjectDir, deriveProjectKey } from '../../project-key.js';
import { decayMemories } from '../../persist.js';
import {
  HOME,
  EVENT,
  payloadProjectRoot,
  safeOpenDb,
  logDiag,
  buildCounts,
  buildStatusLine,
  buildRecentSummary,
  buildWorkingMemoryPreview,
  buildStaleMemoryLine,
  buildSessionThread,
  readLatestStats,
  runAutoGcThrottled,
  safeHandleStop,
  maybeApplyReadyDream,
  emitLines,
  readLatestSessionFocus,
  buildSessionFocusLine,
  firstContentLine,
} from './_helpers.js';
import { runConsolidate } from '../../consolidate.js';
import { saveMemory, linkMemory, mergeMemory } from '../../persist.js';
import { buildDreamStatus } from '../../dream.js';
import { searchMemories } from '../../persist.js';

export async function handleSessionStart(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) {
    emitLines([`[kimi-memory] event=${EVENT} skipped: no project cwd in payload`]);
    return { ok: false, reason: 'no project cwd in payload' };
  }
  const ingest = await safeHandleStop(payload, cwd);
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
  const globalDbPath = path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite');
  const projectDb = safeOpenDb(projectDbPath);
  const globalDb = safeOpenDb(globalDbPath);

  let decay = null;
  if (projectDb) {
    try {
      decay = decayMemories(projectDb, key);
    } catch (e) {
      decay = { error: e && e.message };
    }
  }
  const counts = buildCounts({ projectDb, globalDb, key });
  const recentSummary = buildRecentSummary(projectDb, globalDb, key);
  const {
    extract: latestExtract,
    workLog: latestWorkLog,
    focus: latestFocus,
  } = await readLatestStats(cwd);

  let consolidate = null;
  if (projectDb) {
    try {
      consolidate = await runConsolidate({
        db: projectDb,
        projectKey: key,
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      if (consolidate && (consolidate.saved || consolidate.skipped || consolidate.merged)) {
        await logDiag('info', 'consolidate result', { key, consolidate });
      }
    } catch (e) {
      consolidate = { error: e && e.message };
    }
  }

  let autoGc = null;
  if (projectDb) {
    try {
      autoGc = runAutoGcThrottled(projectDb, key);
      if (autoGc && (autoGc.pruned || autoGc.archived || autoGc.prune || autoGc.archive)) {
        await logDiag('info', 'auto-gc result', { key, autoGc });
      }
    } catch (e) {
      autoGc = { error: e && e.message };
    }
  }

  let dream = null;
  if (projectDb) {
    try {
      const applyResult = await maybeApplyReadyDream(projectDb, key);
      const status = buildDreamStatus(projectDb, key);
      dream = { ...status, apply: applyResult };
      if (applyResult && applyResult.apply && applyResult.apply.ok) {
        await logDiag('info', 'dream apply result', { key, apply: applyResult.apply });
      }
    } catch (e) {
      dream = { label: 'err:' + (e && e.message), error: e && e.message };
    }
  }

  const lines = [];
  lines.push(
    buildStatusLine({
      event: 'SessionStart',
      key,
      cwd,
      counts,
      ingest,
      extract: latestExtract,
      workLog: latestWorkLog,
      focus: latestFocus,
      consolidate,
      autoGc,
      dream,
    }),
  );
  lines.push(recentSummary);
  const focus = readLatestSessionFocus(projectDb, key);
  const focusLine = buildSessionFocusLine(focus);
  if (focusLine) lines.push(focusLine);
  const threadLines = buildSessionThread(projectDb, key);
  if (threadLines) {
    for (const l of threadLines) lines.push(l);
  }
  // Opportunistic recall of project build/stack memories so the agent
  // can see saved project context before it acts.
  if (projectDb) {
    try {
      const recallHits = await searchMemories(
        projectDb,
        key,
        'build command stack dependencies update',
        { limit: 2, perType: true, includeScore: true },
      );
      const topRecall = [...recallHits].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 2);
      for (const m of topRecall) {
        const raw = (m.title || '').trim() || (m.content || '').slice(0, 80);
        const truncated = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
        const snippet = firstContentLine(m.content);
        const tail = snippet ? ` — ${snippet}` : '';
        lines.push(`[recall: project] "${truncated}" (${m.type}, project)${tail}`);
      }
    } catch {
      // recall is best-effort at SessionStart
    }
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  const staleMemoryLine = buildStaleMemoryLine(projectDb, key, cwd);
  if (staleMemoryLine) lines.push(staleMemoryLine);
  emitLines(lines);
  if (decay) await logDiag('info', 'decay pass result', { key, decay });
  return {
    ok: true,
    key,
    counts,
    recent: recentSummary,
    wm: wm.length,
    focus: focusLine ? true : false,
    ingest,
    decay,
    extract: latestExtract,
    workLog: latestWorkLog,
    stale_memory: staleMemoryLine ? true : false,
    dream,
  };
}
