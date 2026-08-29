// UserPromptSubmit handler. On every prompt: composite recall + ingest
// + AI-facing recall context. The human-readable message is intentionally
// minimal — just the recall summary line — so the user's chat transcript
// isn't dominated by verbose counts.

import path from 'node:path';
import { ensureProjectDir, deriveProjectKey } from '../../project-key.js';
import {
  HOME,
  EVENT,
  payloadProjectRoot,
  payloadPrompt,
  safeOpenDb,
  buildRecallContextLines,
  buildRecallSummary,
  safeHandleStop,
  emitLines,
  readLatestSessionFocus,
  buildSessionFocusLine,
} from './_helpers.js';
import { matchAdvisor, logAdvisorDiag } from '../../advisor/detect.js';

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
  const prompt = payloadPrompt(payload);
  const recall = await buildRecallSummary({ projectDb, globalDb, key, prompt });
  const focus = readLatestSessionFocus(projectDb, key);
  const focusLine = buildSessionFocusLine(focus);

  let advisorMatch = null;
  try {
    advisorMatch = matchAdvisor(prompt);
  } catch (e) {
    logAdvisorDiag('matchAdvisor threw: ' + (e && e.message)).catch(() => {});
  }

  // The human-readable message rendered inside the user's <hook_result>
  // tag is intentionally minimal: just the recall summary line. The
  // verbose status line (`event=… project_key=… pmem.active=…`), the
  // focus line, and the working-memory preview used to ride along here
  // and dominated every prompt's first three lines. Counts and ingest
  // results still flow through `result` (which the dispatcher logs into
  // `_diagnostics/hooks.log`), and the per-memory recall hits still
  // flow through `hookSpecificOutput.additionalContext` so the model
  // can acknowledge them. Nothing the user actually wanted to read was
  // being lost — we were just emitting it on stdout where it looked
  // like noise. (Audit finding — verbose UserPromptSubmit output.)
  //
  // The focus line moves to additionalContext so the model still gets
  // the "what were we working on" signal — it just doesn't render in
  // the user's chat anymore.
  const message = `[kimi-memory] ${recall.summary || 'No recall hits.'}`;
  const recallContext = buildRecallContextLines(recall, recall.topHits);
  const additionalContextParts = [];
  if (recallContext) additionalContextParts.push(recallContext);
  if (focusLine) additionalContextParts.push(focusLine);
  if (advisorMatch) {
    additionalContextParts.push(
      `[advisor] matched: "${advisorMatch}" — /advisor or ask naturally; skill \`advisor\` is loaded`,
    );
  }
  const additionalContext = additionalContextParts.length
    ? additionalContextParts.join('\n')
    : undefined;
  const output = {
    message,
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
    ingest,
    recall_hits: {
      project: recall.projectHits.length,
      global: recall.globalHits.length,
    },
    recall_lines: recall.recallLines,
    per_type: recall.perTypeCounts,
    focus: focusLine ? true : false,
    advisor: advisorMatch,
    additional_context: additionalContext,
  };
}
