// Dream lifecycle hooks: enqueue (Stop / SessionEnd), dreaming pass
// and ready-job apply (SessionStart).
//
// Each entry point is gated by env opt-out and an input check and
// swallows failures into a `{ skipped }` result so a Dream problem
// never crashes the hook process.

import { saveMemory, linkMemory, mergeMemory } from '../../../persist.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  findReadyJob,
  shouldEnqueue as shouldEnqueueDream,
  lastDreamEnqueuedAt,
  getAutoApplyConfidence,
} from '../../../dream.js';
import { runDreaming } from '../../../dreaming.js';

// Phase-1 Dream enqueue. Called from Stop / SessionEnd after the
// extract + work-log + session-focus steps have completed. Failures
// are swallowed + logged.
export async function maybeEnqueueDream(projectDb, projectKey, cwd) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAM === 'off') return { skipped: 'env_opt_out' };
  if (!cwd) return { skipped: 'no_cwd' };
  let eventCount = 0;
  try {
    eventCount = projectDb
      .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
      .get(projectKey).n;
  } catch {
    return { skipped: 'snapshot_threw' };
  }
  let last;
  try {
    last = lastDreamEnqueuedAt(projectDb, projectKey);
  } catch {
    last = null;
  }
  const gate = shouldEnqueueDream(projectDb, projectKey, {
    lastEnqueuedAt: last,
    eventCount,
  });
  if (!gate.enqueue) {
    return { skipped: gate.reason };
  }
  let enqueue;
  try {
    enqueue = enqueueDreamJob(projectDb, projectKey, { triggered_by: 'lifecycle' });
  } catch (e) {
    return { skipped: 'enqueue_threw', error: e && e.message };
  }
  if (enqueue && enqueue.status === 'enqueued' && enqueue.job_id) {
    try {
      const r = await generateProposalsForJob(projectDb, projectKey, enqueue.job_id, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      return { ...enqueue, generate: r };
    } catch (e) {
      return { ...enqueue, generate: { ok: false, reason: 'threw', error: e && e.message } };
    }
  }
  return enqueue;
}
// wall-clock floor or activity gate). Called from SessionStart. The
// orchestrator decides mode + interval + include set from the
// per-project state file at $KIMI_CODE_HOME/kimi-memory/<project>/
// dreaming.json (with the global _config/dreaming.json as fallback).
// Returns the run summary so the status line can render the result.
// (Fires when the floor has elapsed or `force` is true; otherwise
// returns `{ fired: false, skipped: 'below_interval' }`.)
export async function maybeDreaming({ projectDb, projectKey, cwd, force = false, kimiHomeDir }) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAMING === 'off') return { skipped: 'env_opt_out' };
  let result;
  try {
    result = await runDreaming({
      db: projectDb,
      projectKey,
      cwd,
      force,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir,
    });
  } catch (e) {
    return { skipped: 'threw', error: e && e.message ? e.message : String(e) };
  }
  return result;
}
// Phase-1 Dream apply. Called from SessionStart. We only ever apply
// one job per SessionStart so the 8s hook budget is never overrun.
export async function maybeApplyReadyDream(projectDb, projectKey) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAM === 'off') return { skipped: 'env_opt_out' };
  let readyId;
  try {
    readyId = findReadyJob(projectDb, projectKey);
  } catch {
    return { skipped: 'lookup_threw' };
  }
  if (!readyId) return { skipped: 'no_ready' };
  try {
    const r = applyDreamJob(projectDb, projectKey, readyId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: getAutoApplyConfidence(),
    });
    return { applied_job_id: readyId, apply: r };
  } catch (e) {
    return { applied_job_id: readyId, skipped: 'apply_threw', error: e && e.message };
  }
}
