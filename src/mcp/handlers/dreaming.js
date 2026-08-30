// Dreaming MCP handler (1 tool — the `dreaming` verb).
//
//   dreaming { sub: "status" }
//   dreaming { sub: "on",      interval_spec: "3h" }
//   dreaming { sub: "off" }
//   dreaming { sub: "auto" }
//   dreaming { sub: "run",     force: true }
//   dreaming { sub: "last" }
//
// We consolidate the four spec'd tools (set/status/run/last) into one
// `args`-string tool because the upstream MCP SDK has a bug converting
// arrays of Zod enums to JSON Schema in the v1.29.x line. A single
// JSON-string input avoids the conversion path entirely. The handler
// parses `args` itself.

import { registerTool } from '../lib/register-tool.js';
import { openScopeDb as openScopeDbInner } from '../lib/scope-db.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { saveMemory, linkMemory, mergeMemory } from '../../persist.js';
import {
  DREAMING_PASSES,
  getDreamingStatus,
  humanInterval,
  parseInterval,
  resolveDreamingState,
  runDreaming,
  setDreamingState,
} from '../../dreaming.js';
import { deriveProjectKey } from '../../project-key.js';

function parseArgsField(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  // try to JSON-parse the string
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to a key=value parser for the convenience of
    // shell callers that pass "sub=on,interval=3h" instead of JSON.
  }
  const out = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on';
  return false;
}

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- dreaming (one tool, sub-dispatch) ----
  registerTool(
    server,
    D.dreaming,
    async (args, ctx) => {
      const opts = parseArgsField(args.args);
      const sub = asString(opts.sub) || 'status';
      const scope = opts.scope === 'global' ? 'global' : 'project';
      if (
        !DREAMING_PASSES.includes(sub) &&
        !['on', 'off', 'auto', 'status', 'run', 'last'].includes(sub)
      ) {
        return {
          operation: 'dreaming',
          error: `unknown sub: ${sub} (expected on|off|auto|status|run|last)`,
        };
      }

      // ----- configuration transitions -----
      if (sub === 'on' || sub === 'off' || sub === 'auto') {
        const projectKey = scope === 'global' ? '_global' : deriveProjectKey(ctx.cwd);
        let intervalMs;
        if (opts.interval_spec != null) {
          const parsed = parseInterval(String(opts.interval_spec));
          if (parsed == null) {
            return {
              operation: 'dreaming_set',
              scope,
              sub,
              error: `interval_spec must be a duration like 30m, 3h, 24h, 1d (got ${opts.interval_spec})`,
            };
          }
          intervalMs = parsed;
        } else if (Number.isFinite(Number(opts.interval_ms))) {
          intervalMs = Math.max(0, Math.trunc(Number(opts.interval_ms)));
        }
        if (
          opts.interval_spec == null &&
          Number.isFinite(Number(opts.interval_ms)) &&
          Number(opts.interval_ms) > 0 &&
          Number(opts.interval_ms) < 300_000
        ) {
          return {
            operation: 'dreaming_set',
            scope,
            sub,
            error: 'interval_ms must be >= 300000 (5 minutes). Use --interval 5m or larger.',
          };
        }
        const include = asList(opts.include);
        let next;
        try {
          next = await setDreamingState({
            projectKey,
            mode: sub,
            intervalMs,
            include: include.length ? include : undefined,
            kimiHomeDir: home,
          });
        } catch (e) {
          return {
            operation: 'dreaming_set',
            scope,
            sub,
            error: e && e.message ? e.message : String(e),
          };
        }
        return {
          operation: 'dreaming_set',
          scope,
          sub,
          mode: next.mode,
          intervalMs: next.intervalMs,
          intervalHuman: humanInterval(next.intervalMs),
          include: next.include,
          sources: next.sources,
          note: 'last_run was reset so the new floor takes effect immediately.',
        };
      }

      // ----- status -----
      if (sub === 'status') {
        const status = getDreamingStatus({ projectKey: ctx.projectKey, kimiHomeDir: home });
        return {
          operation: 'dreaming_status',
          project_key: ctx.projectKey,
          ...status,
        };
      }

      // ----- last -----
      if (sub === 'last') {
        const status = getDreamingStatus({ projectKey: ctx.projectKey, kimiHomeDir: home });
        return {
          operation: 'dreaming_last',
          project_key: ctx.projectKey,
          last_run: status.last_run,
        };
      }

      // ----- run -----
      if (sub === 'run') {
        const key = ctx.projectKey;
        const include = asList(opts.include);
        const exclude = asList(opts.exclude);
        const state = resolveDreamingState({ projectKey: key, kimiHomeDir: home });
        let passes = include.length ? include : [...state.include];
        if (exclude.length) {
          passes = passes.filter((p) => !exclude.includes(p));
        }
        if (passes.length === 0) {
          return {
            operation: 'dreaming_run',
            project_key: key,
            error:
              'include/exclude intersection is empty; nothing to run. Pass at least one of: consolidate, dream, gc.',
          };
        }
        const result = await runDreaming({
          db: ctx.db,
          projectKey: key,
          cwd: ctx.cwd,
          force: asBool(opts.force),
          saveMemory,
          memoryLink: linkMemory,
          mergeMemory,
          kimiHomeDir: home,
        });
        result.include = passes;
        return {
          operation: 'dreaming_run',
          project_key: key,
          ...result,
        };
      }

      return { operation: 'dreaming', error: `unhandled sub: ${sub}` };
    },
    handlers,
    home,
  );
}
