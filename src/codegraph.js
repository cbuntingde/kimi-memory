// CodeGraph subsystem — ported from TencentDB-Agent-Memory's
// `MemoryKnowledge/engines/code/` (`MemoryKnowledge/openapi.yaml`
// Code-Graph endpoints). Provides source-symbol extraction, BFS over
// the call graph, and impact-path queries.
//
// Data lives alongside the per-project memories table (same SQLite
// file). Two new edge kinds are added to memory_edges: 'imports',
// 'calls', 'defines'. The buildCodeGraphEdges helper writes edges
// directly into memory_edges so the existing BFS in queryMemoryGraph
// works against the same data shape — no separate codegraph_edges
// table is needed.
//
// Pure helpers for symbol extraction (regex-based for JS / Python)
// live here. A real implementation would swap in tree-sitter; the
// shape of the helpers is what consumers see, not the parser.

import { promises as fs, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso, hashId, shortId, asString } from './util.js';

// Allowed memory_edges.kind values for codegraph edges. Stable
// vocabulary — the dashboard and any external consumers key off
// these strings. Joined to the pre-existing kinds (related, supports,
// contradicts, supersedes, synthesizes) at the schema layer via the
// v10 + Phase 5 migration.
export const CODEGRAPH_KINDS = ['imports', 'calls', 'defines'];
const CODEGRAPH_KIND_SET = new Set(CODEGRAPH_KINDS);

export function validCodegraphKinds() {
  return [...CODEGRAPH_KIND_SET];
}

export function isValidCodegraphKind(kind) {
  return CODEGRAPH_KIND_SET.has(kind);
}

/**
 * Extract function / class / const / method symbols + ES `import … from`
 * lines from a JavaScript or Python source body. The return shape is
 * `{ symbols: [{name, kind}], imports: [{module, symbols}] }`.
 *
 *   - JS: matches `export function NAME`, `export class NAME`, `const NAME =`,
 *     `function NAME(`, `class NAME`. Imports: `import { x, y } from 'mod'`.
 *   - Python: matches `def NAME(`, `class NAME`. Imports: `from MOD import a, b`.
 *
 * Other extensions return `{ symbols: [], imports: [] }` so the
 * walker skips them gracefully.
 */
export function extractSymbolsFromText(text, ext) {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : '';
  if (typeof text !== 'string' || text.length === 0) {
    return { symbols: [], imports: [] };
  }
  if (cleanExt === '.js' || cleanExt === '.mjs' || cleanExt === '.cjs' || cleanExt === '.ts') {
    return extractJsSymbols(text);
  }
  if (cleanExt === '.py') {
    return extractPySymbols(text);
  }
  return { symbols: [], imports: [] };
}

function extractJsSymbols(text) {
  const symbols = [];
  const seen = new Set();
  function add(name, kind) {
    if (!name || typeof name !== 'string') return;
    if (name.length === 0 || name.length > 128) return;
    if (seen.has(name + ':' + kind)) return;
    seen.add(name + ':' + kind);
    symbols.push({ name, kind });
  }
  // Function / method / class declarations. Patterns accept either
  // `function NAME(`, `async function NAME(`, `export function NAME(`,
  // `class NAME`, `export class NAME`, `const NAME =`, `let NAME =`,
  // and `var NAME =`. We don't try to be a full parser — these are
  // useful heuristics for keyword recall.
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = fnRe.exec(text)) !== null) add(m[1], 'function');
  const clsRe = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g;
  while ((m = clsRe.exec(text)) !== null) add(m[1], 'class');
  const constRe = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = constRe.exec(text)) !== null) add(m[1], 'constant');
  const imports = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(text)) !== null) {
    const syms = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (syms.length > 0) imports.push({ module: m[2], symbols: syms });
  }
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  while ((m = sideEffectRe.exec(text)) !== null) {
    imports.push({ module: m[1], symbols: [] });
  }
  return { symbols, imports };
}

function extractPySymbols(text) {
  const symbols = [];
  const seen = new Set();
  function add(name, kind) {
    if (!name || typeof name !== 'string') return;
    if (name.length === 0 || name.length > 128) return;
    if (seen.has(name + ':' + kind)) return;
    seen.add(name + ':' + kind);
    symbols.push({ name, kind });
  }
  const defRe = /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g;
  let m;
  while ((m = defRe.exec(text)) !== null) add(m[1], 'function');
  const clsRe = /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)\b/g;
  while ((m = clsRe.exec(text)) !== null) add(m[1], 'class');
  const imports = [];
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+([^;\n]+)/gm;
  while ((m = fromRe.exec(text)) !== null) {
    const syms = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (syms.length > 0) imports.push({ module: m[1], symbols: syms });
  }
  return { symbols, imports };
}

/**
 * Walk a project root and extract symbols from every .js / .ts / .py
 * file under it. Skips node_modules, .git, and dotdirs at the top
 * level. Caps the number of files visited via the `limit` option
 * (default 200). Returns [{file, ext, symbols, imports}].
 */
export async function extractCodeGraph(rootDir, { limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(5000, limit));
  const out = [];
  await walk(rootDir, '', out, cap);
  return out;
}

// Files larger than this are skipped by extractCodeGraph. A multi-MB
// source file would otherwise pay 5+ full regex passes over its body
// on every SessionStart. (Audit finding H5.)
const MAX_SYMBOL_FILE_BYTES = 1024 * 1024;

// Resolve `p` to its symlink-free real path. Returns the input on any
// error (ENOENT, EPERM, …) so the caller can still try to read it as
// a literal path. Used by the walker's symlink guard.
async function safeRealpath(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

// Containment check: is `child` strictly inside `parent`? Both inputs
// are expected to already be realpath-resolved. Normalizes both paths
// to forward slashes + lowercase on Windows so case and slash-style
// mismatches don't produce false negatives (Windows paths are
// case-insensitive but case-preserving). Accepts either child === parent
// or child with any leading separator after parent.
function normalizeForContainment(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  // Windows: case-insensitive paths. Lowercase before comparing so
  // `C:\Users\X` matches `c:\users\x`.
  if (process.platform === 'win32') s = s.toLowerCase();
  // Strip a trailing slash to avoid double-slash collisions.
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
function isInside(parent, child) {
  if (!parent || !child) return false;
  const p = normalizeForContainment(parent);
  const c = normalizeForContainment(child);
  if (!p || !c) return false;
  if (p === c) return true;
  return c.startsWith(p + '/');
}

async function walk(rootDir, rel, out, cap, realRootArg) {
  if (out.length >= cap) return;
  const abs = rel ? path.join(rootDir, rel) : rootDir;
  // Symlink guard: a symlink under the project root could point
  // anywhere on disk (e.g. /etc), and node:sqlite has no sandbox.
  // Resolve the walk root once at the top; for every directory entry
  // we resolve symlinks and refuse anything whose realpath escapes
  // the realpath of the project root. realRoot is passed down
  // through recursion so each level compares against the same
  // project root (the previous shape set realRoot = null on
  // recursion, which made the walker return immediately).
  // (Audit fix C1.)
  const realRoot = realRootArg || (rel === '' ? await safeRealpath(abs) : null);
  if (!realRoot) return;
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Resolve symlinks (and plain dirs whose parent is a symlink)
      // before deciding whether to descend. A symlink pointing
      // outside the project root (e.g. an attacker-planted
      // `node_modules -> /etc`) is rejected.
      const realChild = await safeRealpath(childAbs);
      if (!isInside(realRoot, realChild)) continue;
      // Skip noisy top-level dirs at every depth (node_modules, dotdirs
      // such as .git / .cache). (Audit fix BUG-14.)
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      await walk(rootDir, childRel, out, cap, realRoot);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs' && ext !== '.ts' && ext !== '.py') {
      continue;
    }
    // File size cap — skip huge files before regex passes. (H5.)
    let stat;
    try {
      stat = await fs.stat(childAbs);
    } catch {
      continue;
    }
    if (stat.size > MAX_SYMBOL_FILE_BYTES) continue;
    let body;
    try {
      body = await fs.readFile(childAbs, 'utf8');
    } catch {
      continue;
    }
    const { symbols, imports } = extractSymbolsFromText(body, ext);
    out.push({ file: childRel, ext, symbols, imports });
  }
}

/**
 * Build call/imports/define edges between memories that share a
 * symbol. Each (file, symbol) tuple becomes a candidate; when ≥2
 * memories in the project mention the same symbol, an edge is
 * inserted between them (kind=`opts.kind`). Returns
 * `{ inserted, candidates }`.
 *
 * `opts.apply=false` runs as a dry-run — candidates are counted but
 * no rows are inserted. `opts.kind` defaults to `'calls'`.
 *
 * Self-loops are dropped (linkMemory would also drop them; this is a
 * belt-and-braces check). When `inserted === 0` because no symbol
 * has ≥2 memories, `candidates === 0` too — the contract asserted by
 * tests/26-codegraph.test.js.
 */
export function buildCodeGraphEdges(db, projectKey, files, opts = {}) {
  const apply = !!opts.apply;
  const kind = opts.kind && CODEGRAPH_KIND_SET.has(opts.kind) ? opts.kind : 'calls';
  const now = nowIso();

  // Group memories by the symbols they touch. A "touch" is any token
  // that appears in the row's title or content and matches a symbol
  // extracted from one of the files. The previous shape loaded every
  // active memory's full row into Node memory and never used the
  // result — the actual lookup is done via the FTS5 query inside the
  // loop below. For a 50k-memory project this leaked ~50k row
  // objects per SessionStart; with `extractCodeGraph` running from a
  // hook that budgets in single-digit seconds, that leak was the
  // failure mode. (Audit fix BUG-8.)
  let candidates = 0;
  let inserted = 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_edges (id, project_key, from_id, to_id, kind, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
  );

  // Build a per-file symbol set, then for each memory that contains
  // any of the symbols, mark an edge candidate between every pair of
  // memories that share the same symbol. Each (memory, symbol) match
  // is a candidate; the edge count grows by combinations of pairs.
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const fileSymbols = new Set();
      for (const s of file.symbols || []) fileSymbols.add(s.name);
      for (const imp of file.imports || []) {
        for (const sym of imp.symbols || []) fileSymbols.add(sym);
      }
      if (fileSymbols.size === 0) continue;
      // Find memories that contain any of the symbols. Use the FTS5
      // index instead of LIKE scans — LIKE cannot use any index and
      // forced a full table scan per symbol. For a project with N
      // memories and S symbols per file across F files, this is the
      // difference between O(F*S*N) queries and O(F*S) — bound by
      // the FTS5 result count, not the memory count.
      // (Audit finding H4 / B4-1.)
      const matching = new Map(); // symbol → array of memory ids
      const ftsStmt = db.prepare(
        `SELECT m.id FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ?
           AND m.project_key = ?
           AND m.status = 'active'
           AND m.id NOT LIKE 'wiki-%'`,
      );
      for (const sym of fileSymbols) {
        // Per-symbol try/catch: a malformed FTS5 token (e.g. one that
        // begins or ends with `"` after the doubling escape) would
        // otherwise throw and abort the entire codegraph_build_edges
        // call. A single bad symbol is now skipped, not fatal.
        // (Audit fix C2.)
        let hit;
        try {
          const escaped = sym.replace(/"/g, '""');
          hit = ftsStmt.all(`"${escaped}"*`, projectKey);
        } catch {
          continue;
        }
        if (hit.length >= 2) {
          candidates += hit.length;
          if (!matching.has(sym)) matching.set(sym, []);
          for (const r of hit) matching.get(sym).push(r.id);
        }
      }
      // For each symbol with ≥2 matching memories, form a C(n,2) set
      // of edges between every pair of co-mentioned memories. Dedup
      // across symbols and files via the seenPairs set.
      const seenPairs = new Set();
      for (const memIds of matching.values()) {
        for (let i = 0; i < memIds.length; i++) {
          for (let j = i + 1; j < memIds.length; j++) {
            const a = memIds[i];
            const b = memIds[j];
            if (a === b) continue;
            const [fromId, toId] = a < b ? [a, b] : [b, a];
            const key = `${fromId}|${toId}|${kind}`;
            if (seenPairs.has(key)) continue;
            seenPairs.add(key);
            const meta = JSON.stringify({
              file: file.file,
              lang: file.ext === '.py' ? 'py' : 'js',
              range: 0,
            });
            if (apply) {
              const r = insert.run(
                shortId(hashId('edge', projectKey, fromId, toId, kind, file.file), 16),
                projectKey,
                fromId,
                toId,
                kind,
                meta,
                now,
              );
              if (r.changes > 0) inserted += 1;
            }
            // For dry-run, do NOT count inserted. candidates is the
            // total candidate count regardless of mode; inserted is
            // strictly the number of rows actually committed.
          }
        }
      }
    }
    if (apply) {
      db.exec('COMMIT');
    } else {
      db.exec('ROLLBACK');
    }
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { inserted, candidates };
}

/**
 * BFS walk of the memory graph from a seed. Honors `max_depth` and
 * `kind`. `max_depth=0` returns only the seed (when it exists).
 * Returns `{ nodes: [{id, ...row}] }`. Includes the seed row in
 * `nodes`; edges are not surfaced here (the caller can list them via
 * `memory_edges` if needed).
 */
export function queryMemoryGraph(db, projectKey, seedId, { kind = null, max_depth = 5 } = {}) {
  const cap = Math.max(0, Math.min(20, max_depth));
  const seen = new Map();
  const queue = [{ id: seedId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth > cap) continue;
    const row = db
      .prepare('SELECT id FROM memories WHERE id = ? AND project_key = ?')
      .get(id, projectKey);
    if (!row) continue;
    if (!seen.has(id)) {
      const full = db
        .prepare(
          `SELECT id, project_key, type, title, content, tags, metadata, provenance, confidence, status, priority, tier, visibility
           FROM memories WHERE id = ? AND project_key = ?`,
        )
        .get(id, projectKey);
      if (full) seen.set(id, full);
    }
    if (depth === cap) continue;
    const where = ['project_key = ?', '(from_id = ? OR to_id = ?)'];
    const params = [projectKey, id, id];
    if (kind) {
      if (!CODEGRAPH_KIND_SET.has(kind)) {
        // Unknown kind — return just the seed.
        break;
      }
      where.push('kind = ?');
      params.push(kind);
    }
    const edges = db
      .prepare(`SELECT from_id, to_id FROM memory_edges WHERE ${where.join(' AND ')}`)
      .all(...params);
    for (const e of edges) {
      const next = e.from_id === id ? e.to_id : e.from_id;
      if (seen.has(next)) continue;
      queue.push({ id: next, depth: depth + 1 });
    }
  }
  return { nodes: [...seen.values()] };
}
