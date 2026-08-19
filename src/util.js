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
    // Strip a leading UTF-8 BOM only on the very first byte of the
    // file. PowerShell `Set-Content -Encoding utf8` (and a number of
    // Windows editors) prepend `\uFEFF`; without the strip, the very
    // first event — usually the initial user prompt, the highest-
    // signal line for the agent — is parsed as malformed and the
    // JSON content is silently lost. (Audit fix BUG-5.)
    let bomStripped = startByte === 0;
    let lineNo = 0;
    let offset = startByte;
    for await (const chunk of stream) {
      if (signal && signal.aborted) break;
      buf += chunk;
      if (!bomStripped && buf.length > 0 && buf.charCodeAt(0) === 0xfeff) {
        buf = buf.slice(1);
        // The BOM occupies 3 bytes on disk but only 1 code unit in the
        // decoded UTF-8 stream; advance the offset so nextByteOffset
        // arithmetic still aligns to physical bytes.
        offset += 3;
        bomStripped = true;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lineNo += 1;
        const isCrlf = line.endsWith('\r');
        const stripped = isCrlf ? line.slice(0, -1) : line;
        const parsed = stripped.length === 0 ? null : safeJsonParse(stripped);
        const lineBytes = Buffer.byteLength(line, 'utf8'); // includes the '\r' on CRLF
        const nlBytes = isCrlf ? 2 : 1;
        yield {
          line: stripped,
          n: lineNo,
          raw: stripped,
          parsed: parsed && parsed.ok ? parsed.value : null,
          error: parsed && !parsed.ok ? parsed.error : null,
          byteOffset: offset,
          // nextByteOffset was previous shape `+ 1` only, which left
          // a CRLF cursor pointing at the trailing `\r` of the just-
          // emitted line. Count the line bytes + terminator bytes so
          // the next read resumes at the start of the next line
          // regardless of which line ending the file uses. (Audit
          // fix BUG-6.)
          nextByteOffset: offset + lineBytes + nlBytes - (isCrlf ? 1 : 0),
        };
        offset += lineBytes + nlBytes;
      }
    }
    if (buf.length > 0) {
      // Honor a lone trailing `\r` at the very end of the file too.
      const trailingCr = buf.endsWith('\r');
      lineNo += 1;
      const stripped = trailingCr ? buf.slice(0, -1) : buf;
      const parsed = stripped.length === 0 ? null : safeJsonParse(stripped);
      const lineBytes = Buffer.byteLength(buf, 'utf8');
      const nlBytes = trailingCr ? 2 : 1;
      yield {
        line: stripped,
        n: lineNo,
        raw: stripped,
        parsed: parsed && parsed.ok ? parsed.value : null,
        error: parsed && !parsed.ok ? parsed.error : null,
        byteOffset: offset,
        nextByteOffset: offset + lineBytes + nlBytes - (trailingCr ? 1 : 0),
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

// Sanitize an exception for return to a remote caller. Strips
// absolute-path fragments, host:port fragments, and long stack dumps
// that could leak filesystem layout, internal IPs, or library versions
// to the agent context. Used by every code path that wraps a caught
// error into an MCP tool response or a CLI line. (Audit fix.)
//
// The shape mirrors toError in src/validation.js but applies a stricter
// regex so a caller who simply forwards `(e && e.message)` does not
// accidentally expose internal strings. Anything we cannot classify
// gets truncated to 200 chars so a verbose third-party exception cannot
// flood the response.
const PATH_FRAGMENT =
  /(?:\/(?:[\w.\-]+\/)+[\w.\-]+)|(?:[A-Za-z]:[\\\/](?:[\w.\-]+[\\\/])+[\w.\-]+)/g;
const HOST_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const SCHEME_URL = /\b[a-z][a-z0-9+.\-]*:\/\/[^\s)]+/gi;
export function safeErrorMessage(e) {
  if (!e) return 'unknown error';
  const raw = typeof e === 'string' ? e : e && e.message ? String(e.message) : 'unknown error';
  if (!raw) return 'unknown error';
  let out = raw
    .replace(SCHEME_URL, '<url>')
    .replace(HOST_PORT, '<addr>')
    .replace(PATH_FRAGMENT, '<path>');
  // Collapse runs of whitespace introduced by the substitutions.
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (out.length > 200) out = out.slice(0, 200) + '…';
  return out || 'unknown error';
}
