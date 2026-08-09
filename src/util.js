// Small shared utilities. ESM, no deps.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function nowIso() {
  return new Date().toISOString();
}

export function nowMs() {
  return Date.now();
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Resolve $KIMI_CODE_HOME; default ~/.kimi-code (no FS side effects).
export function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

// Plugin root resolver. Honoured in two cases:
//   1. KIMI_PLUGIN_ROOT is exported by Kimi for plugin hooks.
//   2. We fall back to the directory of the importing module's URL so the
//      MCP server (which always runs from the plugin root because the
//      manifest's "cwd": "./" pins it) still finds its assets.
export function pluginRoot(importMetaUrl) {
  if (process.env.KIMI_PLUGIN_ROOT) return path.resolve(process.env.KIMI_PLUGIN_ROOT);
  if (importMetaUrl)
    return path.dirname(
      path.dirname(new URL(importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    );
  return process.cwd();
}

export async function readStdin(limitBytes = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    const finish = () => {
      if (aborted) return;
      aborted = true;
      const buf = Buffer.concat(chunks);
      resolve(buf.toString('utf8'));
    };
    process.stdin.on('data', (c) => {
      if (aborted) return;
      total += c.length;
      if (total > limitBytes) {
        chunks.push(Buffer.from('[...truncated]'));
        process.stdin.removeAllListeners('data');
        process.stdin.resume(); // drain
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', (e) => {
      if (!aborted) {
        aborted = true;
        reject(e);
      }
    });
  });
}

// Read a JSONL file. Yields {line, n, raw, parsed, error}. Always tolerant.
export async function* readJsonl(filePath, { startByte = 0, signal } = {}) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  try {
    const stat = await fh.stat();
    if (startByte >= stat.size) return;
    const stream = fh.createReadStream({ start: startByte, end: stat.size - 1, encoding: 'utf8' });
    let buf = '';
    let lineNo = 0;
    let offset = startByte;
    for await (const chunk of stream) {
      if (signal && signal.aborted) break;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lineNo += 1;
        const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
        const parsed = stripped.length === 0 ? null : safeJsonParse(stripped);
        yield {
          line: stripped,
          n: lineNo,
          raw: stripped,
          parsed: parsed && parsed.ok ? parsed.value : null,
          error: parsed && !parsed.ok ? parsed.error : null,
          byteOffset: offset,
          nextByteOffset: offset + Buffer.byteLength(line, 'utf8') + 1,
        };
        offset += Buffer.byteLength(line, 'utf8') + 1;
      }
    }
    if (buf.length > 0) {
      lineNo += 1;
      const stripped = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
      const parsed = stripped.length === 0 ? null : safeJsonParse(stripped);
      yield {
        line: stripped,
        n: lineNo,
        raw: stripped,
        parsed: parsed && parsed.ok ? parsed.value : null,
        error: parsed && !parsed.ok ? parsed.error : null,
        byteOffset: offset,
        nextByteOffset: offset + Buffer.byteLength(buf, 'utf8'),
      };
    }
  } finally {
    try {
      await fh.close();
    } catch {
      /* ignore */
    }
  }
}

export function hashId(...parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(typeof p === 'string' ? p : JSON.stringify(p));
    h.update('\0');
  }
  return h.digest('hex');
}

export function shortId(hex, n = 12) {
  return hex.slice(0, n);
}

export function asString(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

export function asArray(v) {
  return Array.isArray(v) ? v : [];
}

export function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

// Best-effort path-shaped token match used by the hook recall layer.
// Matches absolute paths (POSIX and Windows) anywhere in a string.
// The same regex lived in src/hooks/tool-recall.js and
// src/hooks/run.js; consolidated here so the two call sites cannot
// drift. (Audit finding B3-7.)
export const PATH_REGEX = /(?:[a-zA-Z]:)?[\\/][^\s"',;]+[\\/][^\s"',;]+/g;
// Shell verbs recognised by the tool-call trigger layer.
export const SHELL_VERB_REGEX =
  /\b(pnpm|npm|yarn|bun|node|npx|tsx|ts-node|python|pip|cargo|go|make|cmake|gradle|mvn|docker|kubectl|git|curl|wget|brew|apt|systemctl)\b/g;

export function projectKeyFromCwd(cwd) {
  if (!cwd) return null;
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}
