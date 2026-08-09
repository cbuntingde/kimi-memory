// Tolerant reader for Kimi wire.jsonl archives. Kimi emits line-delimited
// JSON events into <KIMI_CODE_HOME>/sessions/<workDirKey>/<sessionId>/
// wire.jsonl. We never assume a specific schema; we keep the raw line and
// extract a best-effort role/kind/summary.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJsonl, safeJsonParse } from './util.js';

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
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || '';
    })
    .join('');
  return text || null;
}

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
  if (typeof fromMessage === 'string') return fromMessage;
  if (fromMessage && typeof fromMessage === 'object') {
    const text = pickString(
      contentText(fromMessage.content),
      fromMessage.text,
      fromMessage.summary,
      fromMessage.parts && Array.isArray(fromMessage.parts)
        ? fromMessage.parts.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('')
        : null,
    );
    if (text) return text;
  }
  const fromContent = parsed.content;
  if (typeof fromContent === 'string') return fromContent;
  if (Array.isArray(fromContent)) {
    const text = contentText(fromContent);
    if (text) return text;
  }
  const fromText = pickString(parsed.text, parsed.summary, parsed.delta);
  if (fromText) return fromText;
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

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
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
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

export async function findSessionDir(kimiHomeDir, workDirKey, sessionId) {
  const base = path.join(kimiHomeDir, 'sessions', workDirKey, sessionId);
  // Either a wire.jsonl directly under base, or inside.
  try {
    const stat = await fs.stat(path.join(base, 'wire.jsonl'));
    if (stat.isFile()) return path.dirname(stat.parentPath || path.join(base));
  } catch {
    /* ignore */
  }
  try {
    const stat = await fs.stat(base);
    if (stat.isDirectory()) return base;
  } catch {
    /* ignore */
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

export async function locateSessionArchive(
  kimiHomeDir,
  workDirKey,
  sessionId,
  { extraRoots = [] } = {},
) {
  if (!sessionId) return null;
  const roots = [];
  if (workDirKey) roots.push(path.join(kimiHomeDir, 'sessions', workDirKey, sessionId));
  roots.push(path.join(kimiHomeDir, 'sessions', sessionId));
  for (const r of extraRoots) if (r) roots.push(r);

  const relativeCandidates = ['wire.jsonl', path.join('agents', 'main', 'wire.jsonl')];
  for (const r of roots) {
    for (const relative of relativeCandidates) {
      const cand = path.join(r, relative);
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
      if (indexedKey) roots.push(path.join(kimiHomeDir, 'sessions', indexedKey, sessionId));
      for (const r of roots) {
        for (const relative of relativeCandidates) {
          const cand = path.join(r, relative);
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
  if (workDirKey) {
    const start = path.join(kimiHomeDir, 'sessions', workDirKey);
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
