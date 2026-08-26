// UserPromptSubmit handler. On every prompt: composite recall + status
// line + focus + advisor match + working-memory preview + re-clone
// warning + AI-facing recall context.

import path from 'node:path';
import { ensureProjectDir, deriveProjectKey } from '../../project-key.js';
import {
  HOME,
  EVENT,
  payloadProjectRoot,
  payloadPrompt,
  safeOpenDb,
  logDiag,
  buildCounts,
  buildStatusLine,
  buildWorkingMemoryPreview,
  buildStaleMemoryLine,
  buildRecallContextLines,
  buildRecallSummary,
  readLatestStats,
  safeHandleStop,
  emitLines,
  readLatestSessionFocus,
  buildSessionFocusLine,
  formatFocusSegment,
} from './_helpers.js';
import { matchAdvisor, logAdvisorDiag } from '../../advisor/detect.js';
import { buildDreamStatus } from '../../dream.js';

export async function handleUserPromptSubmit(payload) {
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
  const counts = buildCounts({ projectDb, globalDb, key });
  const prompt = payloadPrompt(payload);
  const recall = await buildRecallSummary({ projectDb, globalDb, key, prompt });
  const {
    extract: latestExtract,
    workLog: latestWorkLog,
    focus: latestFocus,
  } = await readLatestStats(cwd);

  let advisorMatch = null;
  try {
    advisorMatch = matchAdvisor(prompt);
  } catch (e) {
    logAdvisorDiag('matchAdvisor threw: ' + (e && e.message)).catch(() => {});
  }

  const lines = [];
  lines.push(
    buildStatusLine({
      event: 'UserPromptSubmit',
      key,
      cwd,
      counts,
      ingest,
      extract: latestExtract,
      workLog: latestWorkLog,
      focus: latestFocus,
      recall: {
        project: recall.projectHits.length,
        global: recall.globalHits.length,
      },
      dream: projectDb ? buildDreamStatus(projectDb, key) : null,
    }),
  );
  if (recall.summary) lines.push(recall.summary);
  const focus = readLatestSessionFocus(projectDb, key);
  const focusLine = buildSessionFocusLine(focus);
  if (focusLine) lines.push(focusLine);
  if (advisorMatch) {
    lines.push(
      `[advisor] matched: "${advisorMatch}" — /advisor or ask naturally; skill \`advisor\` is loaded`,
    );
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  const staleMemoryLine = buildStaleMemoryLine(projectDb, key, cwd);
  if (staleMemoryLine) lines.push(staleMemoryLine);
  emitLines(lines);
  const additionalContext = buildRecallContextLines(recall, recall.topHits);
  const output = {
    systemMessage: lines.join('\n'),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
  try {
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch {
    /* stdout closed; not fatal */
  }
  return {
    ok: true,
    key,
    counts,
    ingest,
    recall_hits: {
      project: recall.projectHits.length,
      global: recall.globalHits.length,
    },
    recall_lines: recall.recallLines,
    per_type: recall.perTypeCounts,
    focus: focusLine ? true : false,
    advisor: advisorMatch,
    stale_memory: staleMemoryLine ? true : false,
    additional_context: additionalContext,
  };
}
