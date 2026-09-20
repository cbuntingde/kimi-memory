// SessionStart handler. Boot-time: status line + decay + embed retry
// + consolidate + auto-GC + opportunistic Dream apply + the
// wall-clock-gated dreaming pass + thread + working-memory preview +
// re-clone warning.

import {
  ensureProjectDir,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
} from '../../project-key.js';
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
  maybeDreaming,
  emitLines,
  readLatestSessionFocus,
  buildSessionFocusLine,
  firstContentLine,
  singleLine,
  RECALL_FENCE_BEGIN,
  RECALL_FENCE_END,
  stripRecallMarkers,
} from './_helpers.js';
import { runConsolidate } from '../../consolidate.js';
import { retryFailedEmbeddings } from '../embed-retry.js';
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
  // Use the canonical builders rather than re-deriving the storage layout
  // here. The previous shape shadowed the imported `projectDbPath` name
  // with a local const, so the layout lived in two places.
  const projectDb = safeOpenDb(projectDbPath(HOME, key));
  const globalDb = safeOpenDb(globalDbPath(HOME));

  let decay = null;
  if (projectDb) {
    try {
      decay = decayMemories(projectDb, key);
    } catch (e) {
      decay = { error: e && e.message };
    }
  }

  let embedRetry = null;
  if (projectDb) {
    try {
      embedRetry = await retryFailedEmbeddings(projectDb, key);
      if (embedRetry && (embedRetry.recovered > 0 || embedRetry.failed > 0)) {
        await logDiag('info', 'embed retry result', { key, embedRetry });
      }
    } catch (e) {
      embedRetry = { error: e && e.message };
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

  // The wall-clock-gated Dreaming pass (consolidate + dream + auto-GC).
  // AGENTS.md documents `KIMI_MEMORY_DREAMING` as gating "the
  // SessionStart dreaming pass" and src/dreaming.js describes
  // runDreaming as called by the SessionStart hook; until this call
  // existed the pass ran only from the `dreaming_run` MCP tool and the
  // CLI, and the `KIMI_MEMORY_DREAMING=off` opt-out gated nothing.
  let dreaming = null;
  if (projectDb) {
    try {
      dreaming = await maybeDreaming({
        projectDb,
        projectKey: key,
        cwd,
        kimiHomeDir: HOME,
      });
      if (dreaming && dreaming.fired) {
        await logDiag('info', 'dreaming pass result', { key, dreaming });
      }
    } catch (e) {
      dreaming = { skipped: 'threw', error: e && e.message };
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
      // Same stored-injection surface as the UserPromptSubmit recall
      // block: these lines land in the session's hook output, so the
      // memory-derived fields are squeezed onto one line each and the
      // whole block is fenced with the shared markers.
      if (topRecall.length > 0) lines.push(RECALL_FENCE_BEGIN);
      for (const m of topRecall) {
        const truncated =
          singleLine(stripRecallMarkers(m.title), 80) ||
          singleLine(stripRecallMarkers(m.content), 80);
        const snippet = singleLine(stripRecallMarkers(firstContentLine(m.content)));
        const tail = snippet ? ` — ${snippet}` : '';
        lines.push(`[recall: project] "${truncated}" (${m.type}, project)${tail}`);
      }
      if (topRecall.length > 0) lines.push(RECALL_FENCE_END);
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
    embedRetry,
    extract: latestExtract,
    workLog: latestWorkLog,
    stale_memory: staleMemoryLine ? true : false,
    dream,
    dreaming,
  };
}
