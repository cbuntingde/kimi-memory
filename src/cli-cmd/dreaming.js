// CLI: dreaming subsystem (mode + interval + include + run/status/last).
//
//   dreaming on|off|auto [--scope project|global] [--interval 3h] [--include ...]
//   dreaming run     [--scope project] [--interval <spec>] [--include ...] [--exclude ...] [--force] [--json]
//   dreaming status  [--scope project|global] [--json]
//   dreaming last    [--scope project] [--json]
import { existsSync } from 'node:fs';
import { openDb, closeDb, saveMemory, linkMemory, mergeMemory } from '../persist.js';
import {
  DREAMING_MODES,
  DREAMING_PASSES,
  getDreamingStatus,
  humanInterval,
  parseInterval,
  resolveDreamingState,
  runDreaming,
  setDreamingState,
} from '../dreaming.js';
import { deriveProjectKey, projectDbPath } from '../project-key.js';
import { homeDir, resolveCwd, emitJson, emitText } from '../cli/lib.js';

function getScopeFlag(args, fallback = 'project') {
  const v = args.flags.scope ? String(args.flags.scope) : fallback;
  if (v !== 'project' && v !== 'global') {
    process.stderr.write(`error: --scope must be project or global (got ${v})\n`);
    process.exit(1);
  }
  return v;
}

function getModeFlag(args) {
  const v = args.flags.mode ? String(args.flags.mode) : null;
  if (v != null && !DREAMING_MODES.includes(v)) {
    process.stderr.write(`error: --mode must be one of ${DREAMING_MODES.join('|')} (got ${v})\n`);
    process.exit(1);
  }
  return v;
}

function parseIncludeFlag(args) {
  const v = args.flags.include ? String(args.flags.include) : null;
  if (v == null) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((p) => !DREAMING_PASSES.includes(p));
  if (bad.length) {
    process.stderr.write(
      `error: --include must be a comma-separated subset of ${DREAMING_PASSES.join(',')} (unknown: ${bad.join(',')})\n`,
    );
    process.exit(1);
  }
  return list;
}

function parseExcludeFlag(args) {
  const v = args.flags.exclude ? String(args.flags.exclude) : null;
  if (v == null) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((p) => !DREAMING_PASSES.includes(p));
  if (bad.length) {
    process.stderr.write(
      `error: --exclude must be a comma-separated subset of ${DREAMING_PASSES.join(',')} (unknown: ${bad.join(',')})\n`,
    );
    process.exit(1);
  }
  return list;
}

function resolveIntervalMs(args) {
  if (args.flags.interval) {
    const ms = parseInterval(String(args.flags.interval));
    if (ms == null) {
      process.stderr.write(
        `error: --interval must be a duration like 30m, 3h, 24h, 1d (got ${args.flags.interval})\n`,
      );
      process.exit(1);
    }
    return ms;
  }
  if (Number.isFinite(Number(args.flags['interval-ms']))) {
    return Math.max(0, Math.trunc(Number(args.flags['interval-ms'])));
  }
  return undefined;
}

export async function cmdDreaming(args) {
  const home = homeDir(args);
  const asJson = !!args.flags.json;
  const sub = (args.positional[0] || '').toString();

  if (!sub) {
    process.stderr.write('error: dreaming requires a subcommand (on|off|auto|run|status|last)\n');
    process.exit(1);
  }

  if (sub === 'on' || sub === 'off' || sub === 'auto') {
    const scope = getScopeFlag(args, 'project');
    const intervalMs = resolveIntervalMs(args);
    const include = parseIncludeFlag(args);
    const projectKey = scope === 'global' ? '_global' : deriveProjectKey(resolveCwd(args));
    const next = await setDreamingState({
      projectKey,
      mode: sub,
      intervalMs,
      include,
      kimiHomeDir: home,
    });
    const out = {
      operation: 'dreaming_set',
      scope,
      mode: next.mode,
      intervalMs: next.intervalMs,
      intervalHuman: humanInterval(next.intervalMs),
      include: next.include,
      sources: next.sources,
    };
    if (asJson) emitJson(out);
    else {
      process.stdout.write(`mode=${out.mode}\n`);
      process.stdout.write(`scope=${scope}\n`);
      process.stdout.write(`interval=${out.intervalHuman} (${out.intervalMs}ms)\n`);
      process.stdout.write(`include=${out.include.join(',')}\n`);
      process.stdout.write('note: last_run was reset so the new floor takes effect immediately.\n');
    }
    return;
  }

  if (sub === 'run') {
    const cwd = resolveCwd(args);
    if (!cwd) {
      process.stderr.write('error: --cwd is required for dreaming run\n');
      process.exit(1);
    }
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (!existsSync(dbPath)) {
      process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
      process.exit(0);
    }
    const db = openDb(dbPath);
    const include = parseIncludeFlag(args);
    const exclude = parseExcludeFlag(args);
    const state = resolveDreamingState({ projectKey: key, kimiHomeDir: home });
    let passes = Array.isArray(include) && include.length ? include : [...state.include];
    if (Array.isArray(exclude) && exclude.length) {
      passes = passes.filter((p) => !exclude.includes(p));
    }
    if (passes.length === 0) {
      process.stderr.write(
        'error: include/exclude intersection is empty; nothing to run. Pass at least one of: consolidate, dream, gc.\n',
      );
      closeDb();
      process.exit(1);
    }
    const result = await runDreaming({
      db,
      projectKey: key,
      cwd,
      force: !!args.flags.force,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir: home,
    });
    result.include = passes;
    if (asJson) emitJson({ operation: 'dreaming_run', project_key: key, ...result });
    else {
      if (result.skipped && !result.fired) {
        process.stdout.write(`skipped=${result.skipped}\n`);
        if (result.next_due_at) process.stdout.write(`next_due_at=${result.next_due_at}\n`);
        closeDb();
        return;
      }
      process.stdout.write(`fired=${result.fired}\n`);
      process.stdout.write(`mode=${result.mode}\n`);
      process.stdout.write(`include=${result.include.join(',')}\n`);
      if (result.passes.consolidate) {
        const c = result.passes.consolidate;
        process.stdout.write(
          `consolidate: scanned=${c.scanned ?? 0} clusters=${c.clusters ?? 0} saved=${c.saved ?? 0} merged=${c.merged ?? 0}\n`,
        );
      }
      if (result.passes.dream) {
        const d = result.passes.dream;
        process.stdout.write(
          `dream: enqueued=${d.enqueued?.status ?? '?'} applied=${d.applied?.applied ?? 0}\n`,
        );
      }
      if (result.passes.gc) {
        const g = result.passes.gc;
        if (g.prune) {
          process.stdout.write(
            `gc.prune: deleted=${g.prune.pruned_deleted ?? 0} superseded=${g.prune.pruned_superseded ?? 0} cold=${g.prune.pruned_cold ?? 0}\n`,
          );
        }
        if (g.archive) {
          process.stdout.write(
            `gc.archive: events=${g.archive.archived_events ?? 0} skill=${g.archive.archived_skills ?? 0}\n`,
          );
        }
      }
      if (result.error) process.stdout.write(`error=${result.error}\n`);
    }
    closeDb();
    return;
  }

  if (sub === 'status') {
    const cwd = resolveCwd(args);
    const key = cwd ? deriveProjectKey(cwd) : null;
    const status = getDreamingStatus({
      projectKey: key,
      kimiHomeDir: home,
    });
    const out = {
      operation: 'dreaming_status',
      project_key: key,
      ...status,
    };
    if (asJson) emitJson(out);
    else {
      process.stdout.write(`mode=${status.mode}\n`);
      process.stdout.write(`interval=${status.intervalHuman} (${status.intervalMs}ms)\n`);
      process.stdout.write(`include=${status.include.join(',')}\n`);
      process.stdout.write(`sources=${JSON.stringify(status.sources)}\n`);
      if (status.last_run && status.last_run.at) {
        process.stdout.write(`last_run.at=${status.last_run.at}\n`);
        process.stdout.write(`last_run.duration_ms=${status.last_run.duration_ms ?? 0}\n`);
      } else {
        process.stdout.write('last_run=(never)\n');
      }
      if (status.next_due_at) process.stdout.write(`next_due_at=${status.next_due_at}\n`);
      process.stdout.write(`due=${status.due}\n`);
    }
    return;
  }

  if (sub === 'last') {
    const cwd = resolveCwd(args);
    const key = cwd ? deriveProjectKey(cwd) : null;
    const status = getDreamingStatus({
      projectKey: key,
      kimiHomeDir: home,
    });
    const out = { operation: 'dreaming_last', project_key: key, last_run: status.last_run };
    if (asJson) emitJson(out);
    else {
      if (!status.last_run) {
        process.stdout.write('no prior dreaming runs\n');
        return;
      }
      emitText('dreaming last_run', status.last_run);
    }
    return;
  }

  process.stderr.write(
    `error: unknown dreaming subcommand: ${sub} (expected on|off|auto|run|status|last)\n`,
  );
  process.exit(1);
}
