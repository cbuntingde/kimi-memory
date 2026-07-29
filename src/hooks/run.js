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
  listMemories,
  searchMemories,
  listWorkingMemory,
  memoryCounts,
  loadIngestState,
  saveIngestState,
  recordConversationEvent,
  updateConversationProgress,
  upsertConversation,
} from '../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../wire.js';

const EVENT = asString(process.env.PM_HOOK_EVENT) || 'unknown';
const HOME = kimiHome();
const DIAG_DIR = path.join(HOME, 'kimi-memory', '_diagnostics');
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
const PAYLOAD_CWD_KEYS = ['cwd', 'workdir', 'workDir', 'project_root', 'projectRoot', 'workspace', 'cwd_path'];
const PAYLOAD_SESSION_KEYS = ['session_id', 'sessionId', 'session', 'id'];
const PAYLOAD_PROMPT_KEYS = ['prompt', 'user_prompt', 'text', 'input'];

async function logDiag(level, message, extra) {
  const line = JSON.stringify({ ts: nowIso(), event: EVENT, level, message, ...(extra || {}) }) + '\n';
  try {
    await fs.mkdir(DIAG_DIR, { recursive: true });
    // Rotate when the file gets too large. The rotation is atomic
    // enough: rename old -> old.1, append a fresh line. Failures here
    // are non-fatal — diagnostics are best-effort.
    try {
      const st = await fs.stat(DIAG_LOG);
      if (st.size >= DIAG_LOG_MAX_BYTES) {
        await fs.rename(DIAG_LOG, DIAG_LOG + '.1').catch(() => { /* ignore */ });
      }
    } catch { /* missing file is fine */ }
    await fs.appendFile(DIAG_LOG, line, 'utf8');
  } catch { /* ignore */ }
  if (level === 'error') {
    try { process.stderr.write('[kimi-memory:hook:' + EVENT + '] ' + message + '\n'); } catch { /* ignore */ }
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function payloadProjectRoot(payload) {
  if (!isPlainObject(payload)) return null;
  // PAYLOAD_CWD_KEYS lists every field name Kimi has shipped for the
  // project's working directory across hook-payload versions. Keep
  // it in sync with the table above.
  for (const key of PAYLOAD_CWD_KEYS) {
    const r = canonicalizeRoot(payload[key]);
    if (r) return r;
  }
  return null;
}

function payloadSessionId(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of PAYLOAD_SESSION_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function payloadPrompt(payload) {
  if (!isPlainObject(payload)) return '';
  for (const key of PAYLOAD_PROMPT_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
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

// Used by the brief summary lines. We deliberately do NOT emit the
// per-memory content in stdout — the agent can pull full content via
// `memory_recall` if it needs it, and the chat stays uncluttered.
// Irregular plurals are passed explicitly; everything else takes the
// default "s" suffix.
function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : (plural || singular + 's')}`;
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

// ---- Snapshot builders ----

function buildCounts({ projectDb, globalDb, key }) {
  const project = projectDb ? memoryCounts(projectDb, key) : zeroCounts();
  const global = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY) : zeroCounts();
  const wm = projectDb ? listWorkingMemory(projectDb, key) : [];
  const conv = projectDb ? projectDb.prepare("SELECT COUNT(*) AS n FROM conversations WHERE project_key=?").get(key).n : 0;
  const events = projectDb ? projectDb.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?").get(key).n : 0;
  return { project, global, wm, conv, events };
}

function zeroCounts() {
  return { total: 0, active: 0, retained: 0, expired: 0, superseded: 0, deleted: 0, by_type: {}, by_status: {}, latest_update_at: null };
}

function buildStatusLine({ event, key, cwd, counts, ingest, recall }) {
  const ingestSeg = formatIngestSegment(ingest);
  const recallSeg = recall ? ` recall project:${recall.project} global:${recall.global}` : '';
  return [
    `[kimi-memory] event=${event}`,
    `project_key=${key}`,
    `pmem.active=${counts.project.active}`,
    `gmem.active=${counts.global.active}`,
    `wm=${counts.wm.length}`,
    `conv=${counts.conv}`,
    `events=${counts.events}`,
    `ingest=${ingestSeg}${recallSeg}`,
    `cwd=${cwd}`,
  ].join(' ');
}

function buildRecentSummary(projectDb, globalDb, key) {
  const projectRecent = projectDb ? listMemories(projectDb, key, { limit: STATUS_RECENT_MEMORIES }) : [];
  const globalRecent = globalDb ? listMemories(globalDb, GLOBAL_PROJECT_KEY, { limit: STATUS_RECENT_GLOBAL }) : [];
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

function buildRecallSummary({ projectDb, globalDb, key, prompt }) {
  const tokens = derivePromptTokens(prompt);
  if (tokens.length === 0) return { summary: null, projectHits: 0, globalHits: 0, query: '' };
  const query = tokens.join(' ');
  let projectHits = [];
  let globalHits = [];
  if (projectDb) projectHits = searchMemories(projectDb, key, query, { limit: PROMPT_RECALL_LIMIT });
  if (globalDb) globalHits = searchMemories(globalDb, GLOBAL_PROJECT_KEY, query, { limit: PROMPT_RECALL_LIMIT });
  const total = projectHits.length + globalHits.length;
  let summary;
  if (total === 0) {
    summary = 'No recall hits.';
  } else {
    const parts = [];
    if (projectHits.length) parts.push(`${projectHits.length} project`);
    if (globalHits.length) parts.push(`${globalHits.length} global`);
    summary = `Recalled ${pluralize(total, 'memory', 'memories')}. (${parts.join(', ')}.)`;
  }
  return { summary, projectHits: projectHits.length, globalHits: globalHits.length, query };
}

function emitLines(lines) {
  if (!lines || lines.length === 0) return;
  try { process.stdout.write(lines.join('\n') + '\n'); } catch { /* ignore */ }
}

// ---- Handlers ----

async function handleSessionStart(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  // Opportunistic ingest of any leftover archive from a previous
  // session start mid-archive — usually 0, never blocks the agent.
  const ingest = await safeHandleStop(payload, cwd);
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
  const globalDbPath2 = path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite');
  const projectDb = safeOpenDb(projectDbPath);
  const globalDb = safeOpenDb(globalDbPath2);
  const counts = buildCounts({ projectDb, globalDb, key });
  const recentSummary = buildRecentSummary(projectDb, globalDb, key);
  const lines = [];
  lines.push(buildStatusLine({ event: 'SessionStart', key, cwd, counts, ingest }));
  lines.push(recentSummary);
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  emitLines(lines);
  return { ok: true, key, counts, recent: recentSummary, wm: wm.length, ingest };
}

async function handleUserPromptSubmit(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  // Capture the ingest result this time instead of discarding it.
  const ingest = await safeHandleStop(payload, cwd);
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
  const globalDbPath2 = path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite');
  const projectDb = safeOpenDb(projectDbPath);
  const globalDb = safeOpenDb(globalDbPath2);
  const counts = buildCounts({ projectDb, globalDb, key });
  const prompt = payloadPrompt(payload);
  const recall = buildRecallSummary({ projectDb, globalDb, key, prompt });
  const lines = [];
  lines.push(buildStatusLine({ event: 'UserPromptSubmit', key, cwd, counts, ingest, recall: { project: recall.projectHits, global: recall.globalHits } }));
  if (recall.summary) lines.push(recall.summary);
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  emitLines(lines);
  return { ok: true, key, counts, ingest, recall_hits: { project: recall.projectHits, global: recall.globalHits } };
}

async function handleStop(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  return safeHandleStop(payload, cwd);
}

async function safeHandleStop(payload, cwd) {
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
    const hit = idx.find((e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId));
    if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
  }
  const archive = await locateSessionArchive(HOME, wdk, sessionId);
  if (!archive) {
    return { ok: true, skipped: 'archive_not_found', session_id: sessionId, work_dir_key: wdk, project_key: key };
  }
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
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
  state.sessions[sessionId] = { work_dir_key: wdk, byte_offset: finalOffset, line_count: lineNo, last_event_at: lastEventAt, last_import_at: nowIso() };
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
  const parsed = raw.length === 0 ? {} : (safeJsonParse(raw).ok ? safeJsonParse(raw).value : { _raw: raw });
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
    try { process.stdout.write(`[kimi-memory] hook ${EVENT} failed: ${err && err.message}\n`); } catch { /* ignore */ }
  } finally {
    // Release cached SQLite handles so subsequent hooks / processes
    // do not race with WAL cleanup.
    try { closeDb(); } catch { /* ignore */ }
  }
}

// Hard-timeout guard: if anything blocks, release cached SQLite
// handles (so any pending WAL writes flush) and exit cleanly after
// 8s. The timeout is shorter than the manifest-level hook timeouts
// (10–15s) on purpose — a slow hook that runs past 8s is most likely
// stuck on I/O we cannot recover from, and we'd rather emit a clean
// exit than be killed mid-write.
const t = setTimeout(() => {
  try { process.stderr.write('[kimi-memory:hook:' + EVENT + '] timeout, exiting\n'); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
}, 8000);
t.unref?.();

main().then(() => process.exit(0)).catch(() => process.exit(0));
