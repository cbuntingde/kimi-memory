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
import { promises as fs } from 'node:fs';

// Canonicalize a project root. Reject empty, non-absolute, and obviously
// dangerous values. On Windows we also normalise the drive letter case.
//
// On non-Windows hosts, a Windows-style absolute path (e.g. C:/foo/bar)
// must NOT be passed through path.resolve — POSIX treats the leading
// "C:" as a filename, so path.resolve('C:/foo/bar') would join it onto
// the current working directory and return a nonsense path. Instead we
// normalise the drive-letter path by hand: convert forward slashes to
// backslashes, then uppercase the drive letter on Windows so
// "C:\foo" and "c:\foo" map identically.
export function canonicalizeRoot(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Must be absolute. We accept Windows and POSIX.
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(trimmed);
  const isPosixAbs = trimmed.startsWith('/');
  if (!isWinAbs && !isPosixAbs) return null;
  if (isWinAbs) {
    // Always normalise the drive letter to uppercase so 'C:\\foo' and
    // 'c:\\foo' map to the same canonical root, regardless of which
    // OS the function is running on. path.resolve lowercases the drive
    // letter on Windows; we pin it here to keep the cross-platform
    // canonical form stable.
    const win = trimmed
      .replace(/\//g, '\\')
      .replace(/^([a-z])(:)/, (_, d, c) => d.toUpperCase() + c);
    return win;
  }
  // POSIX absolute path.
  try {
    return path.resolve(trimmed);
  } catch {
    return null;
  }
}

export function deriveProjectKey(canonicalRoot) {
  if (!canonicalRoot) return null;
  return createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
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
export const GLOBAL_SCOPE = 'global';

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
