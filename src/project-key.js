// Canonical project key derivation. Strict per-project isolation: every
// read/write/delete must be scoped to one project key derived from the
// project root. We never derive a key from inside MCP; we accept the
// resolved project root from the caller (tool payload or hook payload)
// and hash it here.
//
// Three-layer storage model:
//   - per-project durable + working memory + conversations live under
//     <kimiHome>/kimi-memory/<projectKey>/memory.sqlite
//   - global/user durable memory lives under
//     <kimiHome>/kimi-memory/_global/memory.sqlite
//   - shared hook diagnostics live under
//     <kimiHome>/kimi-memory/_diagnostics/hooks.log
// The global database is for curated cross-project memories only;
// sessions, conversation events, working-memory slots, and ingest
// cursors remain strictly project-scoped.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';

// Canonicalize a project root. Reject empty, non-absolute, and obviously
// dangerous values. On Windows we also normalise the drive letter case
// AND lowercase the rest of the path (Windows file systems are
// case-insensitive, so 'C:\Foo' and 'c:\foo' must hash to the same
// project key). Windows paths are run through the win32 normalizer, so
// '.' and '..' segments collapse ('C:\a\..\b' === 'C:\b') and trailing
// separators are stripped ('C:\Foo\bar' === 'C:\Foo\bar\') — otherwise
// each spelling of one directory would split into a separate DB.
//
// On non-Windows hosts, a Windows-style absolute path (e.g. C:/foo/bar)
// must NOT be passed through path.resolve — POSIX treats the leading
// "C:" as a filename, so path.resolve('C:/foo/bar') would join it onto
// the current working directory and return a nonsense path.
//
// UNC paths (`\\server\share\path`) are accepted on Windows hosts and
// treated like drive-letter absolute paths for normalisation. Returning
// null for UNC on POSIX prevents enterprise users from accidentally
// falling through to the special `"null"` hash key.
export function canonicalizeRoot(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Must be absolute. We accept Windows (drive-letter or UNC),
  // backslash or forward-slash separators, and POSIX.
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(trimmed);
  const isUncAbs = /^\\\\[^\\/]+[\\/]/.test(trimmed);
  const isPosixAbs = trimmed.startsWith('/');
  if (!isWinAbs && !isUncAbs && !isPosixAbs) return null;
  if (isWinAbs || isUncAbs) {
    // Normalise separators, then collapse '.' / '..' segments and
    // redundant separators using the Windows-path rules. path.win32 (not
    // the host path module) keeps the result identical on every host, so
    // 'C:\a\..\b' canonicalises to 'C:\b' even when this code runs on
    // Linux. Without this step 'C:\a\..\b', 'C:\a\.\b' and 'C:\b' — all
    // the same directory — hashed to three different project keys. The
    // drive letter (Windows-only) is uppercased so 'c:\foo' and
    // 'C:\foo' map identically. Case-insensitivity of the rest of the
    // path is applied by `deriveProjectKey`, which keeps the canonical
    // form's case unchanged so the path it points to is the exact path
    // the user / OS reported.
    const win = path.win32.normalize(trimmed.replace(/\//g, '\\'));
    // Strip a trailing separator, except on a bare drive root ('C:\')
    // where the separator is part of the path and dropping it would
    // make the result drive-relative.
    const stripped = win.length > 3 ? win.replace(/\\+$/, '') : win;
    if (isWinAbs) {
      return stripped.replace(/^([a-z])(:)/, (_, d, c) => d.toUpperCase() + c);
    }
    return stripped;
  }
  // POSIX absolute path.
  try {
    return path.resolve(trimmed);
  } catch {
    return null;
  }
}

// Platforms whose default file system folds case: Win32 (NTFS) and
// Darwin (APFS / HFS+ unless the volume was formatted case-sensitive).
// On these the project key must fold case, or one directory reached as
// 'C:\Foo' / 'C:\foo' — or '/Users/Foo' / '/users/foo' — splits across
// two memory DBs.
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

// True when `input` is absolute in any dialect canonicalizeRoot accepts.
// `path.isAbsolute` is not enough on its own: on a POSIX host it reports
// a Windows drive path ('C:/foo') as relative, and resolving that would
// join it onto the cwd.
function isAbsoluteAnyDialect(input) {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\[^\\/]+[\\/]/.test(input) || input.startsWith('/');
}

// Best-effort realpath: resolve symlinks / junctions so a directory
// reached through a link and the link's target share one key, and pick
// up the on-disk casing on a case-insensitive file system. A path that
// does not exist yet or is unreadable falls back to the input unchanged,
// so the key stays stable for a directory that is not on disk.
function realpathBestEffort(input) {
  try {
    return realpathSync.native(input);
  } catch {
    try {
      return realpathSync(input);
    } catch {
      return input;
    }
  }
}

export function deriveProjectKey(canonicalRoot) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.trim().length === 0) return null;
  // Anchor a relative input ('src', './proj') to the process cwd before
  // hashing. Previously canonicalizeRoot rejected it and the raw string
  // was hashed verbatim, giving `deriveProjectKey('src')` a stable key
  // indistinguishable from a real project's.
  const absolute = isAbsoluteAnyDialect(canonicalRoot)
    ? canonicalRoot
    : path.resolve(canonicalRoot);
  // Always canonicalize before hashing. Without this, callers that pass
  // a raw `cwd` (mixed case on Windows, dot segments, a trailing
  // separator) get a different hash than callers that pass an already
  // canonicalized root. Funneling through canonicalizeRoot makes the
  // function self-correcting; the resolved absolute path is the fallback
  // if canonicalizeRoot still rejects the input.
  const canonical = canonicalizeRoot(absolute) || absolute;
  // Resolve symlinks / junctions first, then fold case on the platforms
  // whose file systems are case-insensitive. Folding the whole path (not
  // just the drive letter) is what makes mixed-case spellings of one
  // directory land on one key.
  const hashable = realpathBestEffort(canonical);
  const folded = CASE_INSENSITIVE_PLATFORM ? hashable.toLowerCase() : hashable;
  return createHash('sha256').update(folded).digest('hex').slice(0, 16);
}

// Per-project data directory.
// <kimiHome>/kimi-memory/<projectKey>/memory.sqlite
export function projectDataDir(kimiHomeDir, projectKey) {
  return path.join(kimiHomeDir, 'kimi-memory', projectKey);
}

export function projectDbPath(kimiHomeDir, projectKey) {
  return path.join(projectDataDir(kimiHomeDir, projectKey), 'memory.sqlite');
}

export function ingestStatePath(kimiHomeDir, projectKey) {
  return path.join(projectDataDir(kimiHomeDir, projectKey), 'ingest-state.json');
}

export async function ensureProjectDir(kimiHomeDir, projectKey) {
  const dir = projectDataDir(kimiHomeDir, projectKey);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Global (user / cross-project) durable memory location.
// <kimiHome>/kimi-memory/_global/memory.sqlite
// The directory name starts with an underscore by convention to keep
// it visually separated from hashed project keys; the project_key
// column uses the literal "_global" string so existing per-project
// queries never accidentally hit the global database.
export const GLOBAL_PROJECT_KEY = '_global';
export const GLOBAL_DIR_NAME = '_global';

export function globalDataDir(kimiHomeDir) {
  return path.join(kimiHomeDir, 'kimi-memory', GLOBAL_DIR_NAME);
}

export function globalDbPath(kimiHomeDir) {
  return path.join(globalDataDir(kimiHomeDir), 'memory.sqlite');
}

export async function ensureGlobalDir(kimiHomeDir) {
  const dir = globalDataDir(kimiHomeDir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
