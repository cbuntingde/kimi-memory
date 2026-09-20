// Small shared utilities. ESM, no deps.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactSecrets } from './secrets.js';

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
    let truncated = false;
    const finish = () => {
      if (aborted) return;
      aborted = true;
      const buf = Buffer.concat(chunks);
      resolve({ text: buf.toString('utf8'), truncated });
    };
    process.stdin.on('data', (c) => {
      if (aborted) return;
      total += c.length;
      if (total > limitBytes) {
        // The 256 KB cap on stdin payloads is here to keep a runaway
        // Kimi runtime (or a malicious caller) from holding the hook
        // process open. Marking `truncated` lets the caller surface a
        // warning to the diagnostics log; otherwise we silently swallow
        // the tail, including any user-pasted secret bytes the redactor
        // never sees.
        // (Production-readiness review finding F-7.)
        truncated = true;
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

// Read a JSONL file. Yields {line, n, raw, parsed, error, byteOffset,
// nextByteOffset}. Always tolerant. `byteOffset` is the physical byte
// position of the line (after a stripped BOM); `nextByteOffset` is
// where the following line starts, or the file size when this was the
// last one.
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
    // Strip a leading UTF-8 BOM, but only at the very first byte of the
    // file. PowerShell `Set-Content -Encoding utf8` (and a number of
    // Windows editors) prepend `\uFEFF`; without the strip, the very
    // first event — usually the initial user prompt, the highest-
    // signal line for the agent — is parsed as malformed and the
    // JSON content is silently lost. A continuation read (startByte >
    // 0) never sees a BOM, so it must not eat a U+FEFF that happens to
    // sit at the front of its first chunk. (Audit fix BUG-5; the flag
    // used to be initialised the wrong way round, so the strip never
    // ran on a whole-file read.)
    let bomSettled = startByte !== 0;
    let lineNo = 0;
    let offset = startByte;
    for await (const chunk of stream) {
      if (signal && signal.aborted) break;
      buf += chunk;
      if (!bomSettled && buf.length > 0) {
        bomSettled = true;
        if (buf.charCodeAt(0) === 0xfeff) {
          buf = buf.slice(1);
          // The BOM occupies 3 bytes on disk but only 1 code unit in
          // the decoded UTF-8 stream; advance the offset so
          // nextByteOffset arithmetic still aligns to physical bytes.
          offset += 3;
        }
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
        // The line was split at '\n', so the byte the cursor must step
        // over to reach the next line is exactly 1 on both endings — the
        // '\r' of a CRLF pair is already counted inside `lineBytes`.
        // Charging a CRLF line 2 terminator bytes over-advanced `offset`
        // by 1 per line and left every later byteOffset running ahead
        // of the real file position. (Audit fix.)
        yield {
          line: stripped,
          n: lineNo,
          raw: stripped,
          parsed: parsed && parsed.ok ? parsed.value : null,
          error: parsed && !parsed.ok ? parsed.error : null,
          byteOffset: offset,
          nextByteOffset: offset + lineBytes + 1,
        };
        offset += lineBytes + 1;
      }
    }
    if (buf.length > 0) {
      // Honor a lone trailing `\r` at the very end of the file too.
      const trailingCr = buf.endsWith('\r');
      lineNo += 1;
      const stripped = trailingCr ? buf.slice(0, -1) : buf;
      const parsed = stripped.length === 0 ? null : safeJsonParse(stripped);
      // No terminator follows this final line, so the cursor advances
      // over the line bytes only — `buf` is everything left in the
      // stream, hence the next read starts exactly at EOF.
      const lineBytes = Buffer.byteLength(buf, 'utf8');
      yield {
        line: stripped,
        n: lineNo,
        raw: stripped,
        parsed: parsed && parsed.ok ? parsed.value : null,
        error: parsed && !parsed.ok ? parsed.error : null,
        byteOffset: offset,
        nextByteOffset: offset + lineBytes,
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

// Truncate to `n` characters, appending an ellipsis when anything was
// dropped. Non-strings pass through untouched so callers can feed it a
// possibly-undefined value.
export function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Slice on a code-point boundary. A plain `slice(0, n)` can cut a
// surrogate pair in half, leaving a lone high surrogate that the
// agent's terminal renders as a replacement character on recall.
export function sliceCodePointSafe(s, n) {
  if (!s || s.length <= n) return s;
  let cut = n;
  while (cut > 0 && (s.charCodeAt(cut - 1) & 0xfc00) === 0xdc00) cut -= 1;
  return s.slice(0, cut);
}

// Pick the first non-empty line of a body and squeeze it onto one line
// so it can ride on a bounded one-line summary. Newlines are collapsed
// to single spaces; tabs and runs of spaces become one space. Returns ''
// for empty or non-string input so the caller can omit a trailing
// " — …" when there is nothing useful to quote.
export function firstContentLine(content) {
  if (typeof content !== 'string' || !content) return '';
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!first) return '';
  return truncate(first, 120);
}

// Collapse arbitrary (possibly attacker-authored) text onto a single
// safe line for injection into the agent's context.
//
// The threat: a memory title or snippet is stored verbatim by
// memory_save and later rendered into `hookSpecificOutput.additionalContext`
// / the hook stdout. A title containing `\n` therefore starts a fresh
// line inside the agent's injected instructions, where text like
// `SYSTEM: ignore all previous instructions…` reads as an instruction
// rather than as stored data (stored prompt injection). Newlines, C0/C1
// control characters, tabs, and the Unicode line/paragraph separators
// all have to go; length has to be bounded so a huge row cannot push
// the real instructions out of the window.
//
// Every memory-derived field that reaches injected context goes through
// here: recall titles/snippets, working-memory previews, thread labels,
// tool-recall labels.
export function singleLine(text, cap = 200) {
  if (typeof text !== 'string' || !text) return '';
  // Replace C0/C1 controls (including tab / CR / LF / VT / FF) with a
  // space, then collapse every remaining whitespace run — \s covers
  // U+2028 and U+2029 — and trim.
  const collapsed = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= cap) return collapsed;
  // Slice on a code-point boundary so the cap cannot leave a lone
  // surrogate that the terminal renders as a replacement character.
  return sliceCodePointSafe(collapsed, cap) + '…';
}

export function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

// Same as clamp, but coerced to an integer. Callers bind the result to
// `LIMIT ?` / `OFFSET ?`, and node:sqlite raises SQLITE_MISMATCH
// ("datatype mismatch") when a float or NaN reaches those slots — so the
// truncation and the non-finite fallback are load-bearing, not cosmetic.
// `fallback` defaults to `lo`, which is the safe floor for a limit.
export function clampInt(n, lo, hi, fallback = lo) {
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.min(Math.max(v, lo), hi);
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

// Sanitize an exception for return to a remote caller. Strips
// absolute-path fragments, host:port fragments, and URLs that could
// leak filesystem layout or internal IPs to the agent context. (Audit
// fix.)
//
// Callers: the MCP tool wrapper (src/mcp/lib/register-tool.js), the
// HTTP proxy's error responses, the auto-extract retry path, and the
// persist-layer embed error path. It is not yet universal — handlers
// that build their own error strings are responsible for using it.
//
// The shape mirrors toError in src/validation.js but applies a stricter
// regex so a caller who simply forwards `(e && e.message)` does not
// accidentally expose internal strings. Bounding the length is
// `safeErrorMessage`'s job, not this function's: it caps the result at
// 200 chars so a verbose third-party exception cannot flood the
// response, while `sanitizeText` keeps full stack traces for the
// diagnostics log.

// Path-shaped fragment stripped by `sanitizeText`. Three shapes:
//   - a UNC path (`\\fileserver\share\secret.txt`),
//   - a Windows path, including a root-level one (`C:\secret.txt`),
//   - a POSIX absolute path (`/home/alice/secret.js`), anchored to a
//     non-word boundary so a *relative* reference such as
//     `docs/api/reference.md` is left alone — the fragment only starts
//     at a real path position (string start, space, quote, `(`, `=`).
// Path segments containing spaces are NOT covered: tolerating them
// requires matching across word boundaries, which turns ordinary prose
// ("/a then /b") into a false positive. Leaking the tail of a
// space-containing POSIX path is the lesser evil.
const PATH_FRAGMENT =
  /\\\\[A-Za-z0-9._-]{2,}[\\\/][^\s"'<>|,;)]+|(?:[A-Za-z]:[\\\/][^\s"'<>|,;)]*)|(?<![\w.-])\/(?:[\w.\-]+\/)+[\w.\-]+/g;
const HOST_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
// The scheme class is bounded ([a-z0-9+.-]{0,31}) on purpose. With an
// unbounded class, `\b` matches at every letter/dot boundary, so a
// dot-dense string is re-scanned from each position and the match
// attempt becomes O(n²): 64 KB of `a.a.a…` cost ~1.9 s for the regex
// alone (~2.8 s through `sanitizeText`). No real scheme is longer than
// 32 characters. (Audit fix.)
const SCHEME_URL = /\b[a-z][a-z0-9+.\-]{0,31}:\/\/[^\s)]+/gi;

// Strip absolute paths, host:port pairs, URLs, and credential-shaped
// substrings from free text. Shared by `safeErrorMessage` (single line,
// truncated) and the diagnostics log (stack traces, structure preserved).
//
// Redaction is part of the contract, not just hygiene: an error thrown
// by an authenticated call can embed the credential it used, and the
// diagnostics log is on disk for 90 days.
export function sanitizeText(text) {
  if (typeof text !== 'string' || !text) return text;
  return redactSecrets(
    text.replace(SCHEME_URL, '<url>').replace(HOST_PORT, '<addr>').replace(PATH_FRAGMENT, '<path>'),
  );
}

export function safeErrorMessage(e) {
  if (!e) return 'unknown error';
  const raw = typeof e === 'string' ? e : e && e.message ? String(e.message) : 'unknown error';
  if (!raw) return 'unknown error';
  // Collapse runs of whitespace introduced by the substitutions.
  let out = sanitizeText(raw)
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (out.length > 200) out = out.slice(0, 200) + '…';
  return out || 'unknown error';
}
