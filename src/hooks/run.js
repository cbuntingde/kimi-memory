// Shared hook dispatcher. One Node script consumed by every Kimi hook
// event this plugin declares. The Kimi runtime sets the hook's working
// directory to the plugin root, and exposes KIMI_PLUGIN_ROOT + the
// standard payload on stdin. We always fail open: any error is logged
// to a plugin-owned diagnostics file and the process exits 0.
//
// Event-specific logic lives in src/hooks/handlers/<event>.js. This
// file does only boot, stdin parse, handler lookup, fail-open exit,
// and the hard-timeout guard. Per-event handlers stay small because
// they import shared helpers from src/hooks/handlers/_helpers.js.

import { readStdin, safeJsonParse, kimiHome } from '../util.js';
import { closeDb } from '../persist.js';
import { handleSessionStart } from './handlers/session-start.js';
import { handleUserPromptSubmit } from './handlers/user-prompt-submit.js';
import {
  handleStop,
  handleSessionEnd,
  handlePreCompact,
  handleInterrupt,
  handleStopFailure,
} from './handlers/stop.js';
import { handlePostToolUse } from './handlers/post-tool-use.js';
import { handlePostToolUseFailure } from './handlers/post-tool-use-failure.js';
import { logHookDiag } from '../diagnostics.js';
import {
  buildRecallQuery,
  diversifyHitsByType,
  readRecentFilePaths,
  buildSessionThread,
  formatConsolidateSegment,
  setContext,
} from './handlers/_helpers.js';

// HOME is set once per process. EVENT is set per dispatch from the
// hook-shim entry points; the dispatcher below uses the env var
// directly because module-load ordering would otherwise init EVENT
// before the shim has had a chance to set KM_HOOK_EVENT.
const HOME = kimiHome();
const EVENT = process.env.KM_HOOK_EVENT || 'unknown';

// Per-event hard timeouts (ms). Each value MUST be strictly shorter
// than the `timeout` field on the matching hook in kimi.plugin.json:
// the dispatcher enforces its own ceiling so it can release SQLite
// handles and exit cleanly *while the process is still alive*. If
// the dispatcher fires AFTER the manifest budget, the runtime has
// already killed the process and the cleanup runs against a corpse.
//
// Manifest budgets (kimi.plugin.json):
//   PreCompact, Interrupt, StopFailure, PostToolUse, PostToolUseFailure  →  5 s
//   SessionStart, UserPromptSubmit                                       → 10 s
//   Stop, SessionEnd                                                     → 15 s
//
// Dispatcher ceiling = manifest budget − 1 s safety margin.
const HOOK_TIMEOUTS_MS = {
  PreCompact: 4000,
  Interrupt: 4000,
  StopFailure: 4000,
  PostToolUse: 4000,
  PostToolUseFailure: 4000,
  SessionStart: 9000,
  UserPromptSubmit: 9000,
  Stop: 14000,
  SessionEnd: 14000,
};
function hookTimeoutMs(event) {
  return HOOK_TIMEOUTS_MS[event] || 4000;
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
  PreCompact: handlePreCompact,
  Interrupt: handleInterrupt,
  StopFailure: handleStopFailure,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUseFailure,
};

async function main() {
  setContext({ home: HOME, event: EVENT });
  const stdin = await readStdin(256 * 1024);
  // Truncation observability: when the Kimi runtime hands us a payload
  // larger than 256 KiB (a runaway session, a malicious caller, or a
  // transcript tail bigger than the hook budget) the tail is replaced
  // with a 4-char `[...truncated]` placeholder. Log it so the operator
  // can correlate with whatever the agent then complained about.
  // (Production-readiness review finding F-7.)
  if (stdin.truncated) {
    await logHookDiag(EVENT, 'warn', 'stdin_truncated', {
      event: EVENT,
      limit_bytes: 256 * 1024,
    });
  }
  const raw = stdin.text;
  // Parse the stdin payload exactly once. The previous shape ran
  // safeJsonParse twice on every hook, spending a stringify/parse
  // cycle on up-to 256 KiB of JSON unnecessarily. (Audit fix.)
  let parsed;
  if (raw.length === 0) parsed = {};
  else {
    const r = safeJsonParse(raw);
    parsed = r.ok ? r.value : { _raw: raw };
  }
  const handler = HANDLERS[EVENT];
  if (!handler) {
    await logHookDiag(EVENT, 'warn', 'no handler for event', { event: EVENT });
    return;
  }
  try {
    const result = await handler(parsed);
    await logHookDiag(EVENT, 'info', 'handler ok', { event: EVENT, result });
  } catch (err) {
    await logHookDiag(EVENT, 'error', 'handler threw', {
      event: EVENT,
      error: err && err.message,
    });
    try {
      process.stdout.write(`[kimi-memory] hook ${EVENT} failed: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
  } finally {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }
}

// Hard-timeout guard: if anything blocks, release cached SQLite
// handles (so any pending WAL writes flush) and exit cleanly. The
// ceiling is per-event (HOOK_TIMEOUTS_MS above) and is strictly less
// than the manifest budget for that event so the cleanup runs before
// the runtime force-kills us.
const t = setTimeout(() => {
  try {
    process.stderr.write(`[kimi-memory:hook:${EVENT}] timeout, exiting\n`);
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, hookTimeoutMs(EVENT));
t.unref?.();

// Only run the dispatcher when this module is loaded as a hook (i.e.
// KM_HOOK_EVENT is set by one of the hook shim entry points). Tests
// import the module for its helpers; without this guard the module
// would read stdin and exit before the test runner gets a turn.
if (process.env.KM_HOOK_EVENT) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

// Re-exported for backward compatibility with tests and any consumer
// that previously imported these helpers from run.js. They live in
// src/hooks/handlers/_helpers.js now.
export {
  buildRecallQuery,
  diversifyHitsByType,
  readRecentFilePaths,
  buildSessionThread,
  formatConsolidateSegment,
};
