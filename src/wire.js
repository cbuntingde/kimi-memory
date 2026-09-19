// Tolerant reader for Kimi wire.jsonl archives. Kimi emits line-delimited
// JSON events into <KIMI_CODE_HOME>/sessions/<workDirKey>/<sessionId>/
// wire.jsonl. We never assume a specific schema; we keep the raw line and
// extract a best-effort role/kind/summary.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJsonl, truncate } from './util.js';

const ROLE_BY_KIND = new Map([
  ['user', 'user'],
  ['human', 'user'],
  ['assistant', 'assistant'],
  ['ai', 'assistant'],
  ['model', 'assistant'],
  ['tool', 'tool'],
  ['tool_call', 'tool'],
  ['tool_use', 'tool'],
  ['tool_result', 'tool'],
  ['function_call', 'tool'],
  ['function_result', 'tool'],
  ['system', 'system'],
  ['developer', 'system'],
  ['thinking', 'assistant'],
  ['reasoning', 'assistant'],
  ['final', 'assistant'],
]);

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length) return c;
  }
  return null;
}

export function classifyEvent(parsed) {
  if (!parsed || typeof parsed !== 'object') return { role: null, kind: 'unknown' };
  if (parsed.type === 'context.append_message' && parsed.message) {
    return { role: parsed.message.role || null, kind: 'message' };
  }
  if (parsed.type === 'turn.prompt') return { role: 'user', kind: 'message' };
  if (parsed.type === 'context.append_loop_event' && parsed.event) {
    const eventType = parsed.event.type || 'loop_event';
    const role =
      eventType === 'tool.call' || eventType === 'tool.result'
        ? 'tool'
        : eventType === 'content.part'
          ? 'assistant'
          : null;
    return { role, kind: eventType.replaceAll('.', '_') };
  }
  const kind = pickString(parsed.kind, parsed.type, parsed.event, parsed.role) || 'message';
  const role = ROLE_BY_KIND.get(String(kind).toLowerCase()) || null;
  return { role, kind: String(kind).toLowerCase() };
}

function contentText(content) {
  if (typeof content === 'string') {
    const cleaned = stripSystemReminders(content);
    return cleaned || null;
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || '';
    })
    .join('');
  if (!text) return null;
  const cleaned = stripSystemReminders(text);
  return cleaned || null;
}

// Strip agent-injected `<system-reminder>…</system-reminder>` blocks
// from a piece of text. The host runtime injects these blocks into
// user prompts as tooling guidance (todo list reminders, hook results,
// session reminders, etc.); they are not the user's own words and must
// not contaminate durable memories, focus rows, or auto-extract input.
//
// Stripping happens after every text-yielding step in `extractSummary`
// so the conversation_events.summary column carries clean user text.
// If the entire body was a reminder block, return '' so the caller
// treats the row as text-empty (Fix 2's readSessionUserPrompts will
// then drop it via the empty-after-trim filter).
//
// The regex matches both complete `<system-reminder>...</system-reminder>`
// blocks and unclosed leading/trailing fragments, which the runtime
// occasionally emits. Multi-line blocks are handled by the `s` flag.
// Non-greedy so two adjacent reminder blocks don't merge into one.
function stripSystemReminders(text) {
  if (typeof text !== 'string' || !text) return text;
  // Pre-compute once; the regex is module-scoped to avoid re-allocation.
  return text.replace(SYSTEM_REMINDER_RE, '').trim();
}

const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?(?:<\/system-reminder>|$)/gi;

export function extractSummary(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.type === 'turn.prompt') return contentText(parsed.input);
  if (parsed.type === 'context.append_message' && parsed.message) {
    return contentText(parsed.message.content);
  }
  if (parsed.type === 'context.append_loop_event' && parsed.event) {
    const event = parsed.event;
    if (event.type === 'content.part') return contentText([event.part]);
    if (event.type === 'tool.call')
      return `[tool_call] ${event.name || 'unknown'}(${truncate(safeStringify(event.args), 240)})`;
    if (event.type === 'tool.result')
      return `[tool_result] ${truncate(safeStringify(event.result), 240)}`;
  }
  // Try common text paths used by agent protocols.
  const fromMessage = parsed.message;
  if (typeof fromMessage === 'string') return stripSystemReminders(fromMessage);
  if (fromMessage && typeof fromMessage === 'object') {
    const text = pickString(
      contentText(fromMessage.content),
      fromMessage.text,
      fromMessage.summary,
      fromMessage.parts && Array.isArray(fromMessage.parts)
        ? fromMessage.parts.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('')
        : null,
    );
    if (text) return stripSystemReminders(text);
  }
  const fromContent = parsed.content;
  if (typeof fromContent === 'string') return stripSystemReminders(fromContent);
  if (Array.isArray(fromContent)) {
    const text = contentText(fromContent);
    if (text) return text;
  }
  const fromText = pickString(parsed.text, parsed.summary, parsed.delta);
  if (fromText) return stripSystemReminders(fromText);
  if (parsed.tool_call) {
    const t = parsed.tool_call;
    return `[tool_call] ${t.name || t.tool || 'unknown'}(${truncate(safeStringify(t.args || t.arguments || t.input), 240)})`;
  }
  if (parsed.tool_result) {
    const t = parsed.tool_result;
    return `[tool_result] ${truncate(typeof t === 'string' ? t : safeStringify(t), 240)}`;
  }
  return null;
}

// JSON.stringify can throw on BigInt, circular references, or other
// non-serialisable values that occasionally appear in tool-args payloads.
// Wrap once so the wire walker never aborts on a single bad event.
// (Audit finding B1-7.)
function safeStringify(o) {
  try {
    return JSON.stringify(o || {});
  } catch {
    return '[unserialisable]';
  }
}

export function extractCreatedAt(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed.created_at ?? parsed.timestamp ?? parsed.time ?? parsed.ts;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    // Reject future-dated and absurd timestamps. A JSONL row with a
    // bogus "timestamp" used to leak into last_event_at and corrupt
    // the recall surface. (Audit fix H6.)
    if (!Number.isFinite(t)) return null;
    if (t > Date.now() + 60 * 1000) return null;
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      const t = date.getTime();
      // Same future-dated guard for numeric timestamps.
      if (t > Date.now() + 60 * 1000) return null;
      return date.toISOString();
    }
  }
  return null;
}

export async function readSessionIndex(kimiHomeDir) {
  const indexPath = path.join(kimiHomeDir, 'session_index.jsonl');
  const out = [];
  try {
    for await (const ev of readJsonl(indexPath)) {
      if (ev.parsed && typeof ev.parsed === 'object') {
        out.push(ev.parsed);
      }
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return out;
}

// Bounded, single-pass search for a session id on disk. Bounded by
// MAX_DEPTH to prevent runaway recursion. Only descends when a directory
// name looks like a session id (UUID-ish or 8+ char hex/alnum).
const MAX_DEPTH = 3;
const MAX_DIRS = 32;

function looksLikeSessionId(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length < 8) return false;
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// A single path segment that cannot traverse. `session_id` and
// `work_dir_key` reach `locateSessionArchive` straight from MCP callers
// (`conversation_ingest`) and from the on-disk session index, so neither
// is trusted. Without this, a `session_id` of `../../..` resolved to a
// real `wire.jsonl` outside the data root and ingested it.
// `looksLikeSessionId` is stricter than this and is only used by the
// bounded directory scan, so the two are kept separate: a legitimately
// short or dotted-but-safe id must still resolve by direct path.
function isSafePathSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return true;
}

// Belt-and-braces: even with safe segments, refuse to return a path that
// does not resolve underneath the sessions root. Catches any future
// builder that forgets the segment check.
function isUnderSessionsRoot(kimiHomeDir, candidate) {
  const root = path.resolve(kimiHomeDir, 'sessions');
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function locateSessionArchive(
  kimiHomeDir,
  workDirKey,
  sessionId,
  { extraRoots = [] } = {},
) {
  if (!sessionId) return null;
  // Reject a traversing id outright rather than resolving it and
  // checking afterwards — nothing downstream should ever see it.
  if (!isSafePathSegment(sessionId)) return null;
  const safeKey = isSafePathSegment(workDirKey) ? workDirKey : null;
  const roots = [];
  if (safeKey) roots.push(path.join(kimiHomeDir, 'sessions', safeKey, sessionId));
  roots.push(path.join(kimiHomeDir, 'sessions', sessionId));
  for (const r of extraRoots) if (r) roots.push(r);

  const relativeCandidates = ['wire.jsonl', path.join('agents', 'main', 'wire.jsonl')];
  for (const r of roots) {
    for (const relative of relativeCandidates) {
      const cand = path.join(r, relative);
      if (r !== kimiHomeDir && !isUnderSessionsRoot(kimiHomeDir, cand)) continue;
      try {
        const st = await fs.stat(cand);
        if (st.isFile()) return cand;
      } catch {
        /* ignore */
      }
    }
  }
  // If no work-dir key is known, consult the documented top-level index.
  if (!workDirKey) {
    const index = await readSessionIndex(kimiHomeDir);
    const hit = index.find((entry) => {
      const id = entry && (entry.sessionId || entry.session_id || entry.id);
      return id === sessionId;
    });
    if (hit) {
      const indexedDir = hit.sessionDir || hit.session_dir;
      if (indexedDir)
        roots.push(path.isAbsolute(indexedDir) ? indexedDir : path.join(kimiHomeDir, indexedDir));
      const indexedKey = hit.workDirKey || hit.work_dir_key;
      if (isSafePathSegment(indexedKey))
        roots.push(path.join(kimiHomeDir, 'sessions', indexedKey, sessionId));
      for (const r of roots) {
        for (const relative of relativeCandidates) {
          const cand = path.join(r, relative);
          if (r !== kimiHomeDir && !isUnderSessionsRoot(kimiHomeDir, cand)) continue;
          try {
            const st = await fs.stat(cand);
            if (st.isFile()) return cand;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  // Bounded fallback scan within a known work-dir directory only.
  if (safeKey) {
    const start = path.join(kimiHomeDir, 'sessions', safeKey);
    const found = await boundedFind(start, sessionId, 0);
    if (found) return found;
  }
  return null;
}

async function boundedFind(dir, sessionId, depth) {
  if (depth > MAX_DEPTH) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Both loops honour MAX_DIRS. The previous version bounded the
  // session-id match probe but the recursion loop walked every
  // directory unconditionally — a directory with thousands of
  // subdirectories would recurse into all of them.
  // (Audit finding B1-3.)
  let checked = 0;
  for (const e of entries) {
    if (checked++ > MAX_DIRS) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && e.name === sessionId) {
      for (const relative of ['wire.jsonl', path.join('agents', 'main', 'wire.jsonl')]) {
        const cand = path.join(full, relative);
        try {
          const st = await fs.stat(cand);
          if (st.isFile()) return cand;
        } catch {
          /* ignore */
        }
      }
      return null;
    }
  }
  let recursed = 0;
  for (const e of entries) {
    if (recursed++ > MAX_DIRS) break;
    if (e.isDirectory()) {
      const found = await boundedFind(path.join(dir, e.name), sessionId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Walk a single wire.jsonl from `startByte`, yielding structured events.
export async function* walkWire(filePath, startByte = 0, lineBase = 0) {
  for await (const ev of readJsonl(filePath, { startByte })) {
    if (ev.parsed == null) {
      // Preserve the raw line even when malformed.
      yield {
        lineNo: lineBase + ev.n,
        byteOffset: ev.byteOffset,
        nextByteOffset: ev.nextByteOffset,
        raw: ev.raw,
        parsed: null,
        role: null,
        kind: 'malformed',
        summary: null,
        created_at: null,
        error: ev.error ? String(ev.error.message || ev.error) : 'parse error',
      };
      continue;
    }
    const cls = classifyEvent(ev.parsed);
    yield {
      lineNo: lineBase + ev.n,
      byteOffset: ev.byteOffset,
      nextByteOffset: ev.nextByteOffset,
      raw: ev.raw,
      parsed: ev.parsed,
      role: cls.role,
      kind: cls.kind,
      summary: extractSummary(ev.parsed),
      created_at: extractCreatedAt(ev.parsed),
    };
  }
}
