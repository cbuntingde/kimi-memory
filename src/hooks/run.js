// Shared hook runner. One Node script consumed by every Kimi hook event
// this plugin declares. The Kimi runtime sets the hook's working
// directory to the plugin root, and exposes KIMI_PLUGIN_ROOT + the
// standard payload on stdin. We always fail open: any error is logged
// to a plugin-owned diagnostics file and the process exits 0.
//
// SessionStart / UserPromptSubmit emit a compact status line plus a
// bounded number of preview lines so the agent can recall context
// without us echoing raw prompts or full memory bodies. Stop /
// SessionEnd / PreCompact / Interrupt / StopFailure stay quiet on
// stdout and run idempotent ingest so the project's session archive
// grows without blocking Kimi's lifecycle.
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { kimiHome, readStdin, safeJsonParse, nowIso, asString } from '../util.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  ensureProjectDir,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import {
  openDb,
  closeDb,
  saveMemory,
  listMemories,
  searchMemories,
  listWorkingMemory,
  memoryCounts,
  loadIngestState,
  saveIngestState,
  recordConversationEvent,
  updateConversationProgress,
  upsertConversation,
  decayMemories,
  recordProjectPath,
} from '../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../wire.js';
import { runAutoExtract } from '../extract.js';
import { maybeWriteWorkLog, recordWorkLogResult } from '../work-log.js';
import { matchAdvisor, logAdvisorDiag } from '../advisor/detect.js';

const EVENT = asString(process.env.KM_HOOK_EVENT) || 'unknown';
const HOME = kimiHome();
// Diagnostics live next to the plugin's own source tree so the plugin is
// self-contained. `import.meta.dirname` of `src/hooks/run.js` resolves to
// `.../plugins/managed/kimi-memory/src/hooks/`; walk up two levels.
const DIAG_DIR = path.resolve(import.meta.dirname, '..', '..', '_diagnostics');
const DIAG_LOG = path.join(DIAG_DIR, 'hooks.log');
const DIAG_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB before rotation.

// Safety caps. Previews are bounded because the SessionStart payload is
// forwarded to model context; we never want a runaway payload.
const STATUS_RECENT_MEMORIES = 4;
const STATUS_RECENT_WM_SLOTS = 5;
const STATUS_RECENT_GLOBAL = 4;
const PROMPT_RECALL_LIMIT = 4;
const PROMPT_TOKEN_LIMIT = 6;

// Field names Kimi has used across versions for the project's working
// directory in hook payloads. Keep them in one place so payloadProjectRoot
// stays the single point that knows about historical renames.
const PAYLOAD_CWD_KEYS = [
  'cwd',
  'workdir',
  'workDir',
  'project_root',
  'projectRoot',
  'workspace',
  'cwd_path',
];
const PAYLOAD_SESSION_KEYS = ['session_id', 'sessionId', 'session', 'id'];
const PAYLOAD_PROMPT_KEYS = ['prompt', 'user_prompt', 'text', 'input'];

async function logDiag(level, message, extra) {
  const line =
    JSON.stringify({ ts: nowIso(), event: EVENT, level, message, ...(extra || {}) }) + '\n';
  try {
    await fs.mkdir(DIAG_DIR, { recursive: true });
    // Rotate when the file gets too large. The rotation is atomic
    // enough: rename old -> old.1, append a fresh line. Failures here
    // are non-fatal — diagnostics are best-effort.
    try {
      const st = await fs.stat(DIAG_LOG);
      if (st.size >= DIAG_LOG_MAX_BYTES) {
        await fs.rename(DIAG_LOG, DIAG_LOG + '.1').catch(() => {
          /* ignore */
        });
      }
    } catch {
      /* missing file is fine */
    }
    await fs.appendFile(DIAG_LOG, line, 'utf8');
  } catch {
    /* ignore */
  }
  if (level === 'error') {
    try {
      process.stderr.write('[kimi-memory:hook:' + EVENT + '] ' + message + '\n');
    } catch {
      /* ignore */
    }
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// First non-empty string under any of the candidate keys, after
// passing the raw value through `map`. Used by the payload adapters
// below so each one stays a one-liner over a key list.
function payloadStringField(payload, keys, map = (v) => v) {
  if (!isPlainObject(payload)) return null;
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return map(v);
  }
  return null;
}

function payloadProjectRoot(payload) {
  // PAYLOAD_CWD_KEYS lists every field name Kimi has shipped for the
  // project's working directory across hook-payload versions. Keep
  // it in sync with the table above.
  return payloadStringField(payload, PAYLOAD_CWD_KEYS, canonicalizeRoot);
}

function payloadSessionId(payload) {
  return payloadStringField(payload, PAYLOAD_SESSION_KEYS);
}

function payloadPrompt(payload) {
  return payloadStringField(payload, PAYLOAD_PROMPT_KEYS) || '';
}

// Open a database only if it already exists. We never lazy-create the
// global store at hook time: a count against an uninitialised global
// DB would be misleading, and creating an empty file from a hook is a
// confusing side effect.
function safeOpenDb(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    return openDb(dbPath);
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Pick the first non-empty line of a memory body and squeeze it onto
// one line so it can ride on the bounded [recall: i/N] line. Newlines
// are collapsed to single spaces; tabs and runs of spaces become one
// space. The result is trimmed. Returns '' for empty / missing bodies
// so the caller can omit the trailing " — …" when there is nothing
// useful to quote.
function firstContentLine(content) {
  if (typeof content !== 'string' || !content) return '';
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!first) return '';
  return first.length > 120 ? first.slice(0, 120) + '…' : first;
}

// Render one memory as a single `[recall: …]` status line. Shared by
// the per-type recall and the SessionStart build/stack recall so the
// two paths stay in sync. `tag` (when set) replaces the "i/N" index
// — used by SessionStart which has no total. `includeScore=false`
// suppresses the score field for non-ranked previews.
function formatRecallSnippet(m, { scope, index, total, includeScore = true, tag }) {
  const raw = (m.title || '').trim() || (m.content || '').slice(0, 80);
  const truncated = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  const score = includeScore && m.score != null ? `, score=${m.score.toFixed(2)}` : '';
  const snippet = firstContentLine(m.content);
  const tail = snippet ? ` — ${snippet}` : '';
  const slot = tag != null ? tag : `${index + 1}/${total}`;
  return `[recall: ${slot}] "${truncated}" (${m.type}, ${scope}${score})${tail}`;
}

// Used by the brief summary lines. We deliberately do NOT emit the
// per-memory content in stdout — the agent can pull full content via
// `memory_recall` if it needs it, and the chat stays uncluttered.
// Irregular plurals are passed explicitly; everything else takes the
// default "s" suffix.
function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || singular + 's'}`;
}

function derivePromptTokens(prompt) {
  if (!prompt) return [];
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32);
  return tokens.slice(0, PROMPT_TOKEN_LIMIT);
}

function formatIngestSegment(ingest) {
  if (!ingest) return 'none';
  if (ingest.ingested && ingest.ingested > 0) return `ok:${ingest.ingested}`;
  if (ingest.skipped) return `skip:${ingest.skipped}`;
  if (ingest.archive_not_found) return `skip:archive_not_found`;
  if (ingest.ok) return 'ok:0';
  return 'skipped';
}

// Format the auto-extract result for the status line. Keeps it terse —
// the agent gets the same shape from `memory_recall` if it wants
// details. Distinguishes "LLM had no candidates" (clean skip) from
// "LLM returned candidates but we kept N / dropped M / scrubbed K".
function formatExtractSegment(extract) {
  if (!extract) return 'none';
  if (extract.saved && extract.saved > 0)
    return `saved:${extract.saved}/dup:${extract.duplicates || 0}${
      extract.secrets_dropped ? `/sec:${extract.secrets_dropped}` : ''
    }`;
  if (extract.extracted && extract.extracted > 0)
    return `kept:0/dup:${extract.duplicates || 0}/of:${extract.extracted}`;
  if (extract.skipped) return `skip:${extract.skipped}`;
  if (extract.error) return `err:${extract.error}`;
  return 'none';
}

// Format the work-log result for the status line. Same terseness rule
// as extract — full report goes to `logDiag`.
function formatWorkLogSegment(wl) {
  if (!wl) return 'none';
  if (wl.written && wl.written > 0) {
    return wl.updated ? 'updated' : 'saved';
  }
  if (wl.skipped) return `skip:${wl.skipped}`;
  return 'none';
}

// ---- Snapshot builders ----

// Canonical on-disk paths for this plugin. Used by the hook handlers
// to open project + global DBs without re-deriving the layout.
function memoryDbPaths(key) {
  return {
    project: path.join(HOME, 'kimi-memory', key, 'memory.sqlite'),
    global: path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite'),
  };
}

// Common preamble for every payload-bearing hook handler: validate
// the cwd, derive the project key, opportunistically ingest any
// leftover session archive, and open the project + global DBs. Each
// caller still does its own counts/decay/prompt handling on top of
// the returned context.
async function openHookContext(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const ingest = await safeHandleStop(payload, cwd);
  const paths = memoryDbPaths(key);
  return {
    ok: true,
    cwd,
    key,
    ingest,
    projectDb: safeOpenDb(paths.project),
    globalDb: safeOpenDb(paths.global),
  };
}

function buildCounts({ projectDb, globalDb, key }) {
  const project = projectDb ? memoryCounts(projectDb, key) : zeroCounts();
  const global = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY) : zeroCounts();
  const wm = projectDb ? listWorkingMemory(projectDb, key) : [];
  // One round-trip for both conversation + event counts; an absent
  // projectDb skips the query entirely.
  let conv = 0;
  let events = 0;
  if (projectDb) {
    const row = projectDb
      .prepare(
        'SELECT (SELECT COUNT(*) FROM conversations WHERE project_key=?) AS conv, (SELECT COUNT(*) FROM conversation_events WHERE project_key=?) AS events',
      )
      .get(key, key);
    conv = (row && row.conv) || 0;
    events = (row && row.events) || 0;
  }
  return { project, global, wm, conv, events };
}

function zeroCounts() {
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

function buildStatusLine({ event, key, cwd, counts, ingest, recall, extract, workLog }) {
  const ingestSeg = formatIngestSegment(ingest);
  const recallSeg = recall ? ` recall project:${recall.project} global:${recall.global}` : '';
  // Extract + work-log are surfaced only when set, so the line stays
  // short for callers that don't plumb them through.
  const extractSeg = extract ? ` extract=${formatExtractSegment(extract)}` : '';
  const workLogSeg = workLog ? ` work_log=${formatWorkLogSegment(workLog)}` : '';
  return [
    `[kimi-memory] event=${event}`,
    `project_key=${key}`,
    `pmem.active=${counts.project.active}`,
    `gmem.active=${counts.global.active}`,
    `wm=${counts.wm.length}`,
    `conv=${counts.conv}`,
    `events=${counts.events}`,
    `ingest=${ingestSeg}${extractSeg}${workLogSeg}${recallSeg}`,
    `cwd=${cwd}`,
  ].join(' ');
}

function buildRecentSummary(projectDb, globalDb, key) {
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

function buildWorkingMemoryPreview(projectDb, key) {
  if (!projectDb) return [];
  const slots = listWorkingMemory(projectDb, key).slice(0, STATUS_RECENT_WM_SLOTS);
  return slots.map((s) => `- WM ${s.slot}: ${truncate(s.value, 200)}`);
}

async function buildRecallSummary({ projectDb, globalDb, key, prompt }) {
  const tokens = derivePromptTokens(prompt);
  if (tokens.length === 0) {
    return {
      summary: null,
      projectHits: [],
      globalHits: [],
      recallLines: [],
      perTypeCounts: {},
      query: '',
    };
  }
  const query = tokens.join(' ');
  // Use perType + includeScore: the hook should surface a balanced
  // selection across memory types (so the agent sees conventions AND
  // procedures AND working notes, not five rows of the same type),
  // and the scores feed the "[recall: i/N]" title lines the user
  // sees below. PROMPT_RECALL_LIMIT is the per-scope cap.
  //
  // Project + global searches are independent (different DBs, same
  // query string) — run them in parallel.
  const [projectHits, globalHits] = await Promise.all([
    projectDb
      ? searchMemories(projectDb, key, query, {
          limit: PROMPT_RECALL_LIMIT,
          perType: true,
          includeScore: true,
        })
      : Promise.resolve([]),
    globalDb
      ? searchMemories(globalDb, GLOBAL_PROJECT_KEY, query, {
          limit: PROMPT_RECALL_LIMIT,
          perType: true,
          includeScore: true,
        })
      : Promise.resolve([]),
  ]);
  const allHits = [...projectHits, ...globalHits];
  const total = allHits.length;

  // Per-type breakdown across both scopes. The agent uses this to
  // describe the recall in its reply ("I found 2 conventions and a
  // procedure …"); the human reads the same line on the hook status.
  const perTypeCounts = {};
  for (const m of allHits) perTypeCounts[m.type] = (perTypeCounts[m.type] || 0) + 1;

  let summary;
  if (total === 0) {
    summary = 'No recall hits.';
  } else {
    const parts = [];
    if (projectHits.length) parts.push(`${projectHits.length} project`);
    if (globalHits.length) parts.push(`${globalHits.length} global`);
    const typeParts = Object.entries(perTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}: ${n}`);
    const typeStr = typeParts.length ? ` [${typeParts.join(', ')}]` : '';
    summary =
      `Recalled ${pluralize(total, 'memory', 'memories')}. (${parts.join(', ')}.) ${typeStr}`.trim();
  }

  // Per-memory title lines, bounded to the top 3 by score. Each line
  // is a structured prefix the agent (and the dashboard) can parse,
  // with a one-line quote of the memory's title and a content snippet
  // so the user can verify what was recalled without depending on the
  // agent to translate titles into substance. The total count is
  // included so the agent can refer to "memory 1/3" naturally.
  const projectIdSet = new Set(projectHits.map((m) => m.id));
  const recallLines = [];
  const topHits = [...allHits].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
  for (let i = 0; i < topHits.length; i++) {
    const m = topHits[i];
    const scope = projectIdSet.has(m.id) ? 'project' : 'global';
    recallLines.push(formatRecallSnippet(m, { scope, index: i, total }));
  }

  return {
    summary,
    projectHits,
    globalHits,
    recallLines,
    perTypeCounts,
    query,
  };
}

function emitLines(lines) {
  if (!lines || lines.length === 0) return;
  try {
    process.stdout.write(lines.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}

// ---- Handlers ----

async function handleSessionStart(payload) {
  const ctx = await openHookContext(payload);
  if (!ctx.ok) return ctx;
  const { cwd, key, ingest, projectDb, globalDb } = ctx;
  // Decay pass on the project DB: the only mutating action at
  // SessionStart. Runs once per SessionStart, idempotent (re-running
  // on already-decayed rows is a no-op). Failures are logged but
  // never block the status emit below.
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
  const { extract: latestExtract, workLog: latestWorkLog } = await readLatestStats(cwd);
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
    }),
  );
  lines.push(recentSummary);
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
      const topRecall = [...recallHits]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 2);
      for (const m of topRecall) {
        lines.push(formatRecallSnippet(m, { scope: 'project', tag: 'project', includeScore: false }));
      }
    } catch {
      // recall is best-effort at SessionStart
    }
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  emitLines(lines);
  if (decay) await logDiag('info', 'decay pass result', { key, decay });
  return {
    ok: true,
    key,
    counts,
    recent: recentSummary,
    wm: wm.length,
    ingest,
    decay,
    extract: latestExtract,
    workLog: latestWorkLog,
  };
}

async function handleUserPromptSubmit(payload) {
  const ctx = await openHookContext(payload);
  if (!ctx.ok) return ctx;
  const { cwd, key, ingest, projectDb, globalDb } = ctx;
  const counts = buildCounts({ projectDb, globalDb, key });
  const prompt = payloadPrompt(payload);
  const recall = await buildRecallSummary({ projectDb, globalDb, key, prompt });
  // Pull the most recent extract + work-log stats so the status line
  // can advertise what the previous Stop hook did. Cheap file read;
  // never throws.
  const { extract: latestExtract, workLog: latestWorkLog } = await readLatestStats(cwd);
  // Advisor keyword detection runs here, in-process, on the same payload
  // the memory recall just used. One matched keyword → one extra stdout
  // line so the agent knows to consider loading skill `advisor`. No-match
  // is silent. Detection is fail-open: any error is logged and ignored.
  let advisorMatch = null;
  try {
    advisorMatch = matchAdvisor(prompt);
  } catch (e) {
    logAdvisorDiag('matchAdvisor threw: ' + (e && e.message));
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
      recall: {
        project: recall.projectHits.length,
        global: recall.globalHits.length,
      },
    }),
  );
  if (recall.summary) lines.push(recall.summary);
  // Per-memory title lines so the user (and the agent) can see which
  // memories the recall surfaced. Bounded to top 3 by score; emits
  // nothing when there are zero hits (the summary already says
  // "No recall hits.").
  for (const l of recall.recallLines) lines.push(l);
  if (advisorMatch) {
    lines.push(
      `[advisor] matched: "${advisorMatch}" — /advisor or ask naturally; skill \`advisor\` is loaded`,
    );
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  emitLines(lines);
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
    advisor: advisorMatch,
  };
}

async function handleStop(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  const sessionId = payloadSessionId(payload);
  // Open the project DB once. Each sub-step (ingest, extract, work-log)
  // takes this handle instead of reopening, so a single Stop event
  // uses one SQLite connection rather than two or three.
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const db = safeOpenDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  const ingest = await safeHandleStop(payload, cwd, db);
  // Auto-extract piggybacks on the ingest pass: the conversation_events
  // table is now up to date, so we can read the last few exchanges and
  // ask the LLM whether anything durable is worth saving. Failures here
  // are non-fatal — we never throw out of the hook.
  let extract = null;
  if (sessionId && ingest && ingest.ok !== false && !ingest.skipped) {
    try {
      extract = await handleAutoExtract(cwd, sessionId, db);
    } catch (e) {
      extract = { skipped: 'extract_threw', error: e && e.message };
    }
  }
  if (extract) await logDiag('info', 'auto_extract result', { extract });

  // Work-log piggybacks on the same pass: with conversation_events
  // updated, today's activity + commits are deterministic sources for a
  // date-titled episodic memory. Idempotent within the day via
  // supersede=true. Same fail-open contract — never throws out.
  let workLog = null;
  if (ingest && ingest.ok !== false && cwd) {
    try {
      if (db) {
        workLog = await maybeWriteWorkLog({
          db,
          projectKey: key,
          cwd,
          saveMemory,
        });
        recordWorkLogResult(key, workLog);
        await logDiag('info', 'work_log result', { key, workLog });
      }
    } catch (e) {
      workLog = { skipped: 'work_log_threw', error: e && e.message };
      await logDiag('warn', 'work_log threw', { error: e && e.message });
    }
  }

  // Persist the latest extract + work-log stats into the per-project
  // ingest-state file so the next UserPromptSubmit (a separate
  // process) can surface them on its status line. We keep just enough
  // to render the segment — full reports still live in the diagnostics
  // log. Best-effort; any failure here is logged, not thrown.
  if (cwd && (extract || workLog)) {
    try {
      const key = deriveProjectKey(cwd);
      const state = await loadIngestState(HOME, key);
      if (!state.sessions) state.sessions = {};
      if (extract) state.latest_extract = { ...extract, at: nowIso() };
      if (workLog) state.latest_work_log = { ...workLog, at: nowIso() };
      await saveIngestState(HOME, key, state);
    } catch (e) {
      await logDiag('warn', 'failed to persist latest extract/work_log', {
        error: e && e.message,
      });
    }
  }

  return { ok: true, ingest, extract, workLog };
}

// Read the most recently persisted extract + work-log stats for this
// project. Returns nulls for fields that have never been written.
async function readLatestStats(cwd) {
  if (!cwd) return { extract: null, workLog: null };
  try {
    const key = deriveProjectKey(cwd);
    const state = await loadIngestState(HOME, key);
    return { extract: state.latest_extract || null, workLog: state.latest_work_log || null };
  } catch {
    return { extract: null, workLog: null };
  }
}

async function safeHandleStop(payload, cwd, db = null) {
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const sessionId = payloadSessionId(payload);
  if (!sessionId) return { ok: true, skipped: 'no_session_id', session_id: null, project_key: key };
  const state = await loadIngestState(HOME, key);
  if (!state.sessions) state.sessions = {};
  const prev = state.sessions[sessionId] || {};
  let wdk = prev.work_dir_key || null;
  if (!wdk) {
    const idx = await readSessionIndex(HOME);
    const hit = idx.find(
      (e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId),
    );
    if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
  }
  const archive = await locateSessionArchive(HOME, wdk, sessionId);
  if (!archive) {
    return {
      ok: true,
      skipped: 'archive_not_found',
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: key,
    };
  }
  // Reuse the caller's handle when given; otherwise open one. Keeps
  // handleStop's three sub-steps (ingest, extract, work-log) sharing
  // a single SQLite connection per Stop invocation.
  if (!db) db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  // Stamp the canonical project root so memory_prune (run via the MCP
  // server or /kimi-memory:prune) can later detect orphan project DBs.
  // No-op if `cwd` is missing or non-canonical.
  if (cwd) recordProjectPath(db, key, cwd);
  upsertConversation(db, key, sessionId, cwd);
  const startByte = prev.byte_offset || 0;
  let lineNo = prev.line_count || 0;
  let lastEventAt = prev.last_event_at || null;
  let finalOffset = startByte;
  let newEvents = 0;
  const lineBase = lineNo;
  for await (const ev of walkWire(archive, startByte, lineBase)) {
    finalOffset = ev.nextByteOffset;
    lineNo = ev.lineNo;
    recordConversationEvent(db, key, sessionId, ev.lineNo, ev.byteOffset, ev);
    newEvents += 1;
    if (ev.created_at) lastEventAt = ev.created_at;
  }
  updateConversationProgress(db, key, sessionId, finalOffset, lineNo, lastEventAt);
  state.sessions[sessionId] = {
    work_dir_key: wdk,
    byte_offset: finalOffset,
    line_count: lineNo,
    last_event_at: lastEventAt,
    last_import_at: nowIso(),
  };
  await saveIngestState(HOME, key, state);
  return { ok: true, ingested: newEvents, session_id: sessionId, archive, project_key: key };
}

async function handleSessionEnd(payload) {
  // SessionEnd is the final chance to ingest this session. Idempotent
  // and silent on stdout; the only side effect is the project DB.
  return handleStop(payload);
}

async function handlePreCompact(payload) {
  // PreCompact: snapshot the transcript before context compaction. We
  // run the same idempotent ingest and stay silent on stdout.
  const result = await handleStop(payload);
  return { ok: true, snapshot: result };
}

async function handleInterrupt(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload);
  await logDiag('info', 'interrupt observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

async function handleStopFailure(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload);
  await logDiag('warn', 'stop-failure observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

// Cost guards before we spend an LLM call on extraction.
//
// Tuned 2026-08-02: previous bounds (min=6 events, latency=5min) made
// the extract skip almost every real-world session — long pauses
// between turns would age the "in-flight" check out, and the minimum
// excluded single-question research sessions. The new bounds still
// avoid firing on genuinely tiny or stale sessions; raise the env
// override `KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS` if a project wants
// stricter behavior.
const EXTRACT_MIN_EVENTS = 4; // need enough to be worth extracting from
const EXTRACT_MIN_AGE_MS = 0; // not used directly; see EXTRACT_MAX_LATENCY_MS
const EXTRACT_MAX_LATENCY_MS =
  Number(process.env.KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS) || 30 * 60 * 1000; // events must be <30min old

// Build a short transcript from the most recent conversation events.
// Uses the pre-extracted `summary` field; falls back to a snippet of the
// raw payload for events that have no summary (tool calls etc).
function buildTranscript(db, projectKey, sessionId, { limit = 6 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT role, summary, payload, kind, created_at
    FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT ?
  `,
    )
    .all(projectKey, sessionId, limit);
  // Reverse so the transcript reads oldest → newest.
  rows.reverse();
  const out = [];
  for (const r of rows) {
    if (!r.summary) continue;
    const who =
      r.role === 'user'
        ? 'USER'
        : r.role === 'assistant'
          ? 'ASSISTANT'
          : (r.role || 'SYSTEM').toUpperCase();
    out.push(`${who}: ${r.summary}`);
  }
  return out.join('\n\n');
}

// Pull the most-recent event timestamp for the session. Used by the
// cost guard: if the latest exchange is older than EXTRACT_MAX_LATENCY_MS
// the user is no longer in flight, so we skip extraction.
function latestEventAgeMs(db, projectKey, sessionId) {
  const row = db
    .prepare(
      `
    SELECT created_at FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT 1
  `,
    )
    .get(projectKey, sessionId);
  if (!row || !row.created_at) return Infinity;
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

// Triggered after the ingest pass. Cost guards:
//   - env opt-out (KIMI_MEMORY_AUTO_EXTRACT=off) → no-op
//   - config opt-out ([kimi-memory] disable_auto_extract = true) → no-op
//   - session has fewer than EXTRACT_MIN_EVENTS events → skip
//   - latest event older than EXTRACT_MAX_LATENCY_MS → skip
//   - LLM call timed out / failed → skip (counted via result.skipped)
//   - candidates are deduped against existing memories via the hybrid
//     recall (#1); duplicates are dropped, never re-saved
async function handleAutoExtract(cwd, sessionId, db = null) {
  if (!cwd || !sessionId) return { skipped: 'missing_cwd_or_session', saved: 0 };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  if (!db) db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  try {
    const count = db
      .prepare(
        'SELECT COUNT(*) AS n FROM conversation_events WHERE project_key = ? AND session_id = ?',
      )
      .get(key, sessionId).n;
    if (count < EXTRACT_MIN_EVENTS) return { skipped: 'too_few_events', count };
    const age = latestEventAgeMs(db, key, sessionId);
    if (age > EXTRACT_MAX_LATENCY_MS) return { skipped: 'stale_session', age_ms: age };
    const transcript = buildTranscript(db, key, sessionId, { limit: 6 });
    if (!transcript) return { skipped: 'no_summary_text' };
    const existingTitles = db
      .prepare(
        "SELECT title FROM memories WHERE project_key = ? AND status = 'active' AND (title IS NOT NULL AND title != '') ORDER BY updated_at DESC LIMIT 20",
      )
      .all(key)
      .map((r) => r.title);
    const r = await runAutoExtract({
      homeDir: HOME,
      cwd,
      projectKey: key,
      db,
      transcript,
      existingTitles,
      saveMemory,
      searchMemories,
    });
    return r;
  } catch (e) {
    await logDiag('warn', 'auto_extract threw', { error: e && e.message });
    return { skipped: 'extract_threw', error: e && e.message };
  }
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
  PreCompact: handlePreCompact,
  Interrupt: handleInterrupt,
  StopFailure: handleStopFailure,
};

async function main() {
  const raw = await readStdin(256 * 1024);
  const parsed =
    raw.length === 0 ? {} : safeJsonParse(raw).ok ? safeJsonParse(raw).value : { _raw: raw };
  const handler = HANDLERS[EVENT];
  if (!handler) {
    await logDiag('warn', 'no handler for event', { event: EVENT });
    return;
  }
  try {
    const result = await handler(parsed);
    await logDiag('info', 'handler ok', { event: EVENT, result });
  } catch (err) {
    // Fail open: log and exit 0 so Kimi isn't blocked.
    await logDiag('error', 'handler threw', { event: EVENT, error: err && err.message });
    try {
      process.stdout.write(`[kimi-memory] hook ${EVENT} failed: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
  } finally {
    // Release cached SQLite handles so subsequent hooks / processes
    // do not race with WAL cleanup.
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }
}

// Hard-timeout guard: if anything blocks, release cached SQLite
// handles (so any pending WAL writes flush) and exit cleanly after
// 8s. The timeout is shorter than the manifest-level hook timeouts
// (10–15s) on purpose — a slow hook that runs past 8s is most likely
// stuck on I/O we cannot recover from, and we'd rather emit a clean
// exit than be killed mid-write.
const t = setTimeout(() => {
  try {
    process.stderr.write('[kimi-memory:hook:' + EVENT + '] timeout, exiting\n');
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, 8000);
t.unref?.();

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
