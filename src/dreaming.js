// Dreaming subsystem — the user-facing wrapper around consolidate +
// dream + auto-GC.
//
// The existing dream.js owns the durable, per-project job lifecycle
// (`dream_jobs`, `dream_proposals`) and the MCP `dream_*` tools remain
// unchanged. This module is the layer above:
//
//   - State: per-project `dreaming.json` (mode, interval, include set,
//     last run summary) with a global fallback at
//     `$KIMI_CODE_HOME/kimi-memory/_config/dreaming.json`.
//
//   - Scheduling: a wall-clock floor. The plugin never spawns a
//     background daemon — `runDreamingIfDue` is called by the
//     SessionStart hook and the agent-driven `dreaming_run` tool, and
//     it decides whether the floor has elapsed. Set the interval with
//     `--interval 3h` / `--interval 24h` / `--interval 30m`, or via
//     `KIMI_MEMORY_DREAMING_INTERVAL_MS` for the system-wide default.
//
//   - Composition: one call runs consolidate + dream-enqueue/apply +
//     auto-GC, controlled by the include set. The default include set
//     is `consolidate,dream,gc`; auto-extract is excluded by default
//     (different cost profile — outbound LLM call).
//
//   - State transition: `off` / `auto` / `on`. `off` runs nothing
//     automatically; `on` runs on the wall-clock floor; `auto`
//     preserves the existing activity-threshold + debounce behaviour
//     so a single switch to `auto` is a no-op upgrade.
//
// Fail-open: every step is wrapped. A partial run is recorded with
// the error in `last_run.error`; the next SessionStart decides again.

import {
  promises as fs,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { nowIso, safeJsonParse, asString } from './util.js';
import { kimiHome } from './util.js';
import { projectDataDir } from './project-key.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  findReadyJob,
  buildDreamStatus,
} from './dream.js';
import { runConsolidate } from './consolidate.js';
import { runAutoGc } from './auto-gc.js';
import { logHookDiag } from './diagnostics.js';

// ---------- Mode vocabulary ----------

export const DREAMING_MODES = Object.freeze(['off', 'auto', 'on']);
export const DREAMING_PASSES = Object.freeze(['consolidate', 'dream', 'gc']);

// Default include set. auto-extract is intentionally NOT here — it makes
// an outbound LLM call and runs at every Stop, so it has a different
// cost profile. Add it explicitly via the agent or the MCP tool.
const DEFAULT_INCLUDE = ['consolidate', 'dream', 'gc'];

// Default interval: 24h in `on`, 30 min in `auto`. Matches the existing
// KIMI_MEMORY_DREAM_DEBOUNCE_MS default so an upgrade to `auto` is a
// no-op behaviour change.
const DEFAULT_INTERVAL_MS = {
  off: 0,
  auto: 30 * 60 * 1000,
  on: 24 * 60 * 60 * 1000,
};

const DEFAULT_GLOBAL_STATE = Object.freeze({
  mode: 'auto',
  intervalMs: DEFAULT_INTERVAL_MS.auto,
  include: [...DEFAULT_INCLUDE],
  last_run: null,
});

function defaultStateFor(mode) {
  return {
    mode,
    intervalMs: DEFAULT_INTERVAL_MS[mode] ?? DEFAULT_INTERVAL_MS.auto,
    include: [...DEFAULT_INCLUDE],
    last_run: null,
  };
}

// ---------- Interval parsing ----------

// Accepts the human forms we promise on the wire: "30m", "3h", "24h",
// "1d", "1h30m". Returns ms, or null on bad input. Pure; easy to unit
// test.
export function parseInterval(spec) {
  if (typeof spec === 'number' && Number.isFinite(spec) && spec >= 0) return Math.trunc(spec);
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const s = spec.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) * 60 * 1000; // bare integer = minutes (CLI default)
  let total = 0;
  const re = /(\d+)\s*(d|h|m|s)/g;
  let matched = false;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = m[2];
    if (unit === 'd') total += n * 24 * 60 * 60 * 1000;
    else if (unit === 'h') total += n * 60 * 60 * 1000;
    else if (unit === 'm') total += n * 60 * 1000;
    else if (unit === 's') total += n * 1000;
  }
  if (!matched) return null;
  if (total < 0 || !Number.isFinite(total)) return null;
  return total;
}

// ---------- State file layout ----------

// Per-project state lives at:
//   $KIMI_CODE_HOME/kimi-memory/<project>/dreaming.json
// A global fallback lives at:
//   $KIMI_CODE_HOME/kimi-memory/_config/dreaming.json
//
// The agent's `/dreaming` command writes per-project. The global file
// is a system-wide default applied when a project has no override.
function readJsonSafe(p, fallback) {
  try {
    if (!existsSync(p)) return fallback;
    const raw = readFileSync(p, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return fallback;
    return { ...fallback, ...parsed.value };
  } catch {
    return fallback;
  }
}

export function dreamingStatePath(kimiHomeDir, projectKey) {
  if (!projectKey || projectKey === '_global') {
    return path.join(kimiHomeDir, 'kimi-memory', '_config', 'dreaming.json');
  }
  return path.join(projectDataDir(kimiHomeDir, projectKey), 'dreaming.json');
}

function writeJsonSafe(p, payload) {
  const dir = path.dirname(p);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  // Write to a sibling temp file and rename it into place: a crash must
  // not leave a half-written state file, and rename() is atomic within a
  // directory on POSIX and NTFS alike (Node maps it to MoveFileEx with
  // MOVEFILE_REPLACE_EXISTING on Windows, so an existing target is
  // overwritten rather than raising EEXIST — the old copyFileSync dance
  // existed for that reason but also left the temp file behind whenever
  // the copy failed).
  const tmp = p + '.tmp';
  let body;
  try {
    body = JSON.stringify(payload, null, 2);
    writeFileSync(tmp, body);
    renameSync(tmp, p);
    return true;
  } catch (e) {
    // The rename failed (or the temp write did). Remove the orphan temp
    // file either way, then try a direct non-atomic write as a last
    // resort: a torn state file is recoverable, a missing one loses the
    // scheduling clock.
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file was never created */
    }
    try {
      writeFileSync(p, body);
      return true;
    } catch (fallbackError) {
      // Never swallowed silently — a dreaming state file that stops
      // updating is otherwise invisible until the interval stops firing.
      try {
        process.stderr.write(
          `[kimi-memory] dreaming state write failed (${p}): ` +
            `${e && e.message}; fallback: ${fallbackError && fallbackError.message}\n`,
        );
      } catch {
        /* stderr closed */
      }
      return false;
    }
  }
}

// ---------- Effective state ----------

// Resolves the effective state for a project. Per-project override
// wins; global fallback applies otherwise; `KIMI_MEMORY_DREAMING_*`
// env vars override the file values for the current process. Returns
// a fully populated state object — no missing keys.
export function resolveDreamingState({ projectKey, kimiHomeDir = kimiHome() }) {
  const globalPath = dreamingStatePath(kimiHomeDir, '_global');
  const projectPath = dreamingStatePath(kimiHomeDir, projectKey);
  const globalState = readJsonSafe(globalPath, defaultStateFor('auto'));
  const projState =
    projectKey && existsSync(projectPath)
      ? readJsonSafe(projectPath, defaultStateFor(globalState.mode))
      : null;
  const base = projState || globalState;
  const mode = asString(process.env.KIMI_MEMORY_DREAMING_MODE) || asString(base.mode) || 'auto';
  const intervalEnv = Number(process.env.KIMI_MEMORY_DREAMING_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(intervalEnv) && intervalEnv >= 0
      ? Math.trunc(intervalEnv)
      : Number.isFinite(Number(base.intervalMs))
        ? Math.trunc(Number(base.intervalMs))
        : (DEFAULT_INTERVAL_MS[mode] ?? DEFAULT_INTERVAL_MS.auto);
  const include =
    Array.isArray(base.include) && base.include.length
      ? base.include.filter((p) => DREAMING_PASSES.includes(p))
      : [...DEFAULT_INCLUDE];
  return {
    mode: DREAMING_MODES.includes(mode) ? mode : 'auto',
    intervalMs,
    include: include.length ? include : [...DEFAULT_INCLUDE],
    last_run: base.last_run && typeof base.last_run === 'object' ? base.last_run : null,
    sources: {
      project: !!projState,
      global: true,
    },
  };
}

// Persist a state override. Writes to per-project when projectKey is
// given, otherwise to the global fallback.
export async function setDreamingState({
  projectKey,
  mode,
  intervalMs,
  include,
  intervalSpec,
  kimiHomeDir = kimiHome(),
}) {
  const targetPath = dreamingStatePath(kimiHomeDir, projectKey);
  const current =
    projectKey && existsSync(targetPath)
      ? readJsonSafe(targetPath, defaultStateFor('auto'))
      : { ...DEFAULT_GLOBAL_STATE };
  const next = { ...current };
  if (mode != null) {
    if (!DREAMING_MODES.includes(mode)) {
      throw new Error(`invalid mode: ${mode} (must be off|auto|on)`);
    }
    next.mode = mode;
  }
  if (intervalSpec != null) {
    const ms = parseInterval(intervalSpec);
    if (ms == null) {
      throw new Error(`invalid interval: ${intervalSpec} (examples: 30m, 3h, 24h, 1d)`);
    }
    next.intervalMs = ms;
  } else if (Number.isFinite(intervalMs)) {
    next.intervalMs = Math.max(0, Math.trunc(intervalMs));
  }
  if (Array.isArray(include)) {
    const filtered = include.filter((p) => DREAMING_PASSES.includes(p));
    if (!filtered.length) {
      throw new Error(`include must name at least one of: ${DREAMING_PASSES.join(', ')}`);
    }
    next.include = filtered;
  }
  // Reset the last_run clock when mode or interval changes so the new
  // configuration takes effect on the next SessionStart instead of
  // being silently held back by the old floor.
  if (mode != null || intervalSpec != null || intervalMs != null) {
    next.last_run = null;
  }
  writeJsonSafe(targetPath, next);
  return {
    ...next,
    sources: projectKey ? { project: true, global: false } : { project: false, global: true },
  };
}

// ---------- Scheduling decision ----------

// Returns true when a dreaming pass should fire. The wall-clock floor
// is the only gate; a force=true bypasses it for explicit
// `dreaming_run` invocations.
export function shouldDreamNow(state, { now = new Date(), force = false } = {}) {
  if (!state) return false;
  if (state.mode === 'off') return false;
  if (force) return true;
  const last = state.last_run && state.last_run.at ? Date.parse(state.last_run.at) : 0;
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= state.intervalMs;
}

// ---------- The pass itself ----------

// runDreaming executes the configured passes in order, records the
// result, and persists the new last_run timestamp. Designed to be
// called from the SessionStart hook (where the 8s budget means we may
// skip slow passes) and from the explicit `dreaming_run` MCP tool
// (where the agent has no wall-clock constraint).
//
// Pass semantics:
//   - consolidate → runConsolidate(mode: 'direct'). Writes
//     conclusion rows + edges + synthesizes links. Uses the existing
//     v15 small-dataset relax + auto-merge.
//   - dream → if an outstanding job exists (queued/running/ready/
//     partially_applied), enqueue is a no-op (idempotent) and the pass
//     works with the existing job. If no job exists, enqueue one. Then
//     apply it (capped to one apply per call so the 8s hook budget is
//     never overrun). This pass applies without a confidence floor, so
//     it also finishes a job an earlier hook apply left
//     `partially_applied`. The pass summary records the generation
//     result, `ok: false` included — a failure is surfaced, not
//     swallowed.
//   - gc → runAutoGc. Runs all three sub-passes (prune, archive,
//     tier). Honour the existing KIMI_MEMORY_AUTO_GC=off opt-out.
async function runConsolidatePass(db, projectKey, saveMemory, linkMemory, mergeMemory) {
  try {
    if (process.env.KIMI_MEMORY_CONSOLIDATE === 'off') {
      return { skipped: 'env_opt_out' };
    }
    const r = await runConsolidate({
      db,
      projectKey,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      mode: 'direct',
    });
    return r;
  } catch (e) {
    return { skipped: 'threw', error: e && e.message ? e.message : String(e) };
  }
}

async function runDreamPass(db, projectKey, cwd, saveMemory, linkMemory, mergeMemory) {
  const out = { enqueued: null, applied: null };
  try {
    const enq = enqueueDreamJob(db, projectKey, { triggered_by: 'dreaming' });
    out.enqueued = enq;
    // Only attempt apply if a job is ready and apply was not already
    // done in a previous SessionStart. findReadyJob + applyDreamJob
    // are idempotent at the SQL layer; running apply here means a
    // single `dreaming_run` call produces both the proposal set and
    // the live row writes.
    const readyId =
      enq.status === 'enqueued' || enq.status === 'ready'
        ? enq.job_id
        : enq.status === 'duplicate' && enq.job_id
          ? enq.job_id
          : null;
    if (!readyId) {
      const ready = findReadyJob(db, projectKey);
      if (ready) {
        out.applied = applyDreamJob(db, projectKey, ready.id, {
          saveMemory,
          memoryLink: linkMemory,
          mergeMemory,
        });
      }
      return out;
    }
    // For a freshly-enqueued job: generate proposals first, then apply.
    // generateProposalsForJob mutates the job to `ready` so the next
    // apply call can run.
    //
    // Generation must not block the apply path, but its result must not
    // vanish either: `{ ok: false }` means the job carries no (or an
    // incomplete) proposal set, which the previous shape discarded
    // silently. It is recorded on the pass summary — persisted into
    // `last_run` and returned to the hook / MCP / CLI — and logged to
    // the diagnostics pipeline.
    try {
      const generated = await generateProposalsForJob(db, projectKey, readyId, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      out.generate = generated;
      if (generated && generated.ok === false) {
        out.proposal_error = generated.reason || 'generate_failed';
      }
    } catch (e) {
      // generateProposalsForJob reports its own failures rather than
      // throwing, so a throw here is a bug or a DB-level fault; it is
      // surfaced the same way rather than dropped.
      out.generate = { ok: false, reason: 'threw', error: e && e.message };
      out.proposal_error = e && e.message ? e.message : String(e);
    }
    if (out.proposal_error) {
      await logHookDiag('dreaming', 'warn', 'proposal generation failed', {
        projectKey,
        jobId: readyId,
        reason: out.proposal_error,
        error: out.generate && out.generate.error,
      }).catch(() => {});
    }
    out.applied = applyDreamJob(db, projectKey, readyId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
  } catch (e) {
    out.enqueued = { ...(out.enqueued || {}), threw: e && e.message ? e.message : String(e) };
    return out;
  }
  // The success path used to fall off the end of the function, so the
  // pass summary (including a failed proposal generation) was dropped on
  // every run that got this far — `passes.dream` in the `dreaming_run`
  // result and in `last_run` was `undefined` whenever nothing threw.
  return out;
}

function runGcPass(db, projectKey) {
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    return { skipped: 'env_opt_out' };
  }
  try {
    return runAutoGc(db, projectKey);
  } catch (e) {
    return { skipped: 'threw', error: e && e.message ? e.message : String(e) };
  }
}

// Effective pass set for one run. The configured set (project state file)
// is the default; a per-call `include` / `exclude` narrows it for that
// call only — the persisted configuration is never rewritten by a run.
// Returns null when the caller asked for passes but the intersection is
// empty (the `dreaming_run` handler reports that as an error itself, so
// this only guards a direct caller).
function resolvePassInclude(configured, includeOverride, exclude) {
  const override = Array.isArray(includeOverride) || Array.isArray(exclude);
  let passes =
    Array.isArray(includeOverride) && includeOverride.length
      ? [...includeOverride]
      : [...configured];
  passes = passes.filter((p) => DREAMING_PASSES.includes(p));
  if (Array.isArray(exclude) && exclude.length) {
    passes = passes.filter((p) => !exclude.includes(p));
  }
  if (override && passes.length === 0) return null;
  return passes.length ? passes : [...configured];
}

export async function runDreaming({
  db,
  projectKey,
  cwd,
  force = false,
  now = new Date(),
  saveMemory,
  memoryLink,
  mergeMemory,
  kimiHomeDir = kimiHome(),
  include: includeOverride = null,
  exclude = null,
}) {
  const startedAt = now.toISOString();
  const state = resolveDreamingState({ projectKey, kimiHomeDir });
  const include = resolvePassInclude(state.include, includeOverride, exclude);
  const result = {
    mode: state.mode,
    intervalMs: state.intervalMs,
    include: include ? [...include] : [...state.include],
    started_at: startedAt,
    force,
    fired: false,
    skipped: null,
    passes: {},
    error: null,
  };
  if (!db || !projectKey) {
    result.skipped = 'no_db_or_key';
    return result;
  }
  if (!include) {
    result.skipped = 'empty_include';
    return result;
  }
  if (!shouldDreamNow(state, { now, force })) {
    result.skipped = 'below_interval';
    result.next_due_at = new Date(
      (state.last_run && state.last_run.at
        ? Date.parse(state.last_run.at)
        : now.getTime() - state.intervalMs) + state.intervalMs,
    ).toISOString();
    return result;
  }
  result.fired = true;

  if (include.includes('consolidate')) {
    result.passes.consolidate = await runConsolidatePass(
      db,
      projectKey,
      saveMemory,
      memoryLink,
      mergeMemory,
    );
  }
  if (include.includes('dream')) {
    result.passes.dream = await runDreamPass(
      db,
      projectKey,
      cwd,
      saveMemory,
      memoryLink,
      mergeMemory,
    );
  }

  if (include.includes('gc')) {
    result.passes.gc = runGcPass(db, projectKey);
  }

  // Persist the new last_run timestamp + summary. Failures here are
  // logged but never thrown — a state-file write must not break the
  // hook thread.
  const targetPath = dreamingStatePath(kimiHomeDir, projectKey);
  try {
    const current = existsSync(targetPath)
      ? readJsonSafe(targetPath, defaultStateFor(state.mode))
      : state.sources.global && !projectKey
        ? { ...DEFAULT_GLOBAL_STATE }
        : defaultStateFor(state.mode);
    const next = {
      ...current,
      mode: state.mode,
      intervalMs: state.intervalMs,
      // The persisted configuration, not this call's narrowed set: a
      // `dreaming_run` with include/exclude must not rewrite the
      // project's configuration.
      include: state.include,
      last_run: {
        at: nowIso(),
        duration_ms: Date.now() - now.getTime(),
        force,
        passes: result.passes,
      },
    };
    writeJsonSafe(targetPath, next);
  } catch (e) {
    await logHookDiag('dreaming', 'warn', 'state write failed', {
      projectKey,
      error: e && e.message,
    }).catch(() => {});
    result.error = e && e.message ? e.message : String(e);
  }
  return result;
}

// ---------- Status / introspection ----------

// For the dreaming_status tool + slash command. Returns the effective
// state plus a short summary of the last run.
export function getDreamingStatus({ projectKey, kimiHomeDir = kimiHome(), now = new Date() } = {}) {
  const state = resolveDreamingState({ projectKey, kimiHomeDir });
  const lastAt = state.last_run && state.last_run.at ? Date.parse(state.last_run.at) : 0;
  const lastAgoMs = Number.isFinite(lastAt) && lastAt > 0 ? now.getTime() - lastAt : null;
  return {
    mode: state.mode,
    intervalMs: state.intervalMs,
    intervalHuman: humanInterval(state.intervalMs),
    include: [...state.include],
    sources: state.sources,
    last_run: state.last_run,
    next_due_at:
      state.mode === 'off'
        ? null
        : new Date(
            (Number.isFinite(lastAt) && lastAt > 0 ? lastAt : now.getTime()) + state.intervalMs,
          ).toISOString(),
    last_run_age_ms: lastAgoMs,
    due: shouldDreamNow(state, { now }),
  };
}

export function humanInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'off';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// Re-export from dream.js so callers (especially the hook layer) can
// read the staged job status without depending on two modules.
export { buildDreamStatus };
