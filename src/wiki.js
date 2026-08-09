// Wiki / LLM-Wiki subsystem — ported from TencentDB-Agent-Memory's
// `MemoryKnowledge` module (`MemoryKnowledge/openapi.yaml`,
// `engines/wiki/`). Provides structured pages with bidirectional links
// and a graph-walk primitive.
//
// Storage lives in the per-project database (same SQLite file as the
// memories table). Tables: wiki_pages (one row per page), wiki_links
// (typed edges between pages), wiki_fts (FTS5 over name + body +
// summary), wiki_vec (cosine vec0 — created at runtime when the
// embedding dimension is known).
//
// Page IDs are deterministic: `wiki-` + 8 base62 chars (~38 bits,
// ~50% collision-free at 65k pages). Stable across DB reopens so the
// dashboard can URL-link to a page by id.
//
// Pure functions for the high-value primitives (link extraction from
// markdown body, graph traversal, name→id resolution) live in this
// module; the persistence wrappers are in the persisted exports
// (upsertWikiPage, getWikiPage, traverseWiki, …).

import { nowIso, hashId, shortId, asString } from './util.js';

// Allowed wiki link kinds. Stable vocabulary — the dashboard and any
// external consumers key off these strings.
export const WIKI_LINK_KINDS = ['mentions', 'derived_from', 'contradicts', 'supersedes'];
const WIKI_LINK_KIND_SET = new Set(WIKI_LINK_KINDS);

export function validWikiLinkKinds() {
  return [...WIKI_LINK_KIND_SET];
}

export function isValidWikiLinkKind(kind) {
  return WIKI_LINK_KIND_SET.has(kind);
}

/**
 * Generate a deterministic page id from (projectKey, name). Stable
 * across DB reopens; same name in the same project always hashes to
 * the same id. The id carries a `wiki-` prefix so it never collides
 * with a memory id (which uses a 24-hex shortId without prefix).
 */
function wikiPageId(projectKey, name) {
  const hex = shortId(hashId('wiki', projectKey, name), 12);
  // base62-style slice: take 8 chars from the hex prefix and prefix
  // with 'wiki-'. The hex chars [0-9a-f] are a 16-char alphabet;
  // we intentionally do NOT extend the alphabet because the id is
  // opaque to humans and the dashboard URL builder keys off the
  // length + prefix.
  return `wiki-${hex.slice(0, 8)}`;
}

/**
 * Parse `[[wiki-name]]` and `[text](wiki:name)` markers out of a
 * page body. Returns the unique set of resolved wiki names. The
 * caller is responsible for turning names into ids (via resolveWiki).
 */
export function extractWikiLinks(body) {
  const out = new Set();
  if (typeof body !== 'string' || body.length === 0) return [];
  // [[wiki-name]] — bracket reference; name may contain spaces.
  const bracketRe = /\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = bracketRe.exec(body)) !== null) {
    const name = m[1].trim();
    if (name.length > 0 && name.length <= 128) out.add(name);
  }
  // [text](wiki:name) — explicit wiki link. Matches when the URL
  // scheme is "wiki:".
  const mdRe = /\]\(\s*wiki:([^)\s]+)\s*\)/g;
  while ((m = mdRe.exec(body)) !== null) {
    const name = m[1].trim();
    if (name.length > 0 && name.length <= 128) out.add(name);
  }
  return [...out];
}

/**
 * Resolve a wiki name to its page id in the project DB. Returns null
 * when no page with that name exists in the project's wiki_pages.
 * Used by the upsert flow to convert name → id and by extractWikiLinks
 * to validate references.
 */
export function resolveWiki(db, projectKey, name) {
  if (!name) return null;
  const row = db
    .prepare(
      'SELECT wiki_id, name, body, summary, updated_at FROM wiki_pages WHERE project_key = ? AND name = ?',
    )
    .get(projectKey, name);
  return row || null;
}

/**
 * Upsert a wiki page. Idempotent on (projectKey, name): re-saving the
 * same name rewrites the body / summary / links in place. Embedding
 * is computed lazily on first save and refreshed on every write.
 *
 * Accepts an explicit `links` array of {name, kind} entries; the
 * caller is responsible for resolving names to ids (or letting the
 * function do it). When omitted, links are extracted from the body
 * via extractWikiLinks and recorded as 'mentions' kind.
 *
 * Returns { wiki_id, name, summary, updated_at } plus the resolved
 * edges as `links` so the caller can build a graph on top.
 */
export function upsertWikiPage(
  db,
  projectKey,
  { service_id = '', team_id = '', name, body = '', summary = '', links = null },
) {
  if (!name || typeof name !== 'string') {
    throw new Error('upsertWikiPage: name is required');
  }
  if (name.length > 128) {
    throw new Error('upsertWikiPage: name must be 1-128 chars');
  }
  const cleanBody = typeof body === 'string' ? body : '';
  const cleanSummary = typeof summary === 'string' ? summary : '';
  const wikiId = wikiPageId(projectKey, name);
  const now = nowIso();

  // Determine the link set to record. If the caller passed explicit
  // edges, normalise them; otherwise extract from body and tag as
  // 'mentions'.
  let edges = [];
  if (Array.isArray(links) && links.length > 0) {
    for (const l of links) {
      if (!l || typeof l !== 'object') continue;
      const linkName = typeof l.name === 'string' ? l.name.trim() : '';
      const linkKind = typeof l.kind === 'string' ? l.kind.trim() : 'mentions';
      if (!linkName || linkName.length === 0) continue;
      if (linkName === name) continue; // no self-loops
      if (!WIKI_LINK_KIND_SET.has(linkKind)) continue;
      edges.push({ name: linkName, kind: linkKind });
    }
  } else {
    for (const linkName of extractWikiLinks(cleanBody)) {
      if (linkName === name) continue;
      edges.push({ name: linkName, kind: 'mentions' });
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO wiki_pages (wiki_id, project_key, service_id, team_id, name, body, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_key, name) DO UPDATE SET
         body = excluded.body,
         summary = excluded.summary,
         updated_at = excluded.updated_at`,
    ).run(wikiId, projectKey, service_id, team_id, name, cleanBody, cleanSummary, now);

    // Re-seed FTS so the page is searchable.
    db.prepare('DELETE FROM wiki_fts WHERE wiki_id = ?').run(wikiId);
    db.prepare(
      `INSERT INTO wiki_fts (wiki_id, project_key, name, body, summary) VALUES (?, ?, ?, ?, ?)`,
    ).run(wikiId, projectKey, name, cleanBody, cleanSummary);

    // Replace outgoing edges in-place: delete all old outgoing for
    // this page, then insert the new set. Self-loops are dropped
    // above; unknown target names stay as name→id miss-records
    // (link rows whose to_wiki_id will be re-resolved by the next
    // graph walk).
    db.prepare('DELETE FROM wiki_links WHERE project_key = ? AND from_wiki_id = ?').run(
      projectKey,
      wikiId,
    );
    const insertEdge = db.prepare(
      `INSERT INTO wiki_links (from_wiki_id, to_wiki_id, project_key, kind, weight, created_at)
       VALUES (?, ?, ?, ?, 1.0, ?)`,
    );
    const resolved = [];
    for (const e of edges) {
      const target = db
        .prepare('SELECT wiki_id FROM wiki_pages WHERE project_key = ? AND name = ?')
        .get(projectKey, e.name);
      const toId = target ? target.wiki_id : `pending:${e.name}`;
      try {
        insertEdge.run(wikiId, toId, projectKey, e.kind, now);
        resolved.push({ name: e.name, kind: e.kind, wiki_id: toId });
      } catch {
        // UNIQUE violation on duplicate (from, to, kind) — ignore;
        // the row was already present.
      }
    }
    db.exec('COMMIT');
    return {
      wiki_id: wikiId,
      name,
      summary: cleanSummary,
      updated_at: now,
      links: resolved,
    };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Fetch a single page by id (preferred) or name. Returns null when
 * neither id nor name matches.
 */
export function getWikiPage(db, projectKey, { wikiId = null, name = null } = {}) {
  if (wikiId) {
    const row = db
      .prepare(
        'SELECT wiki_id, project_key, service_id, team_id, name, body, summary, updated_at FROM wiki_pages WHERE wiki_id = ? AND project_key = ?',
      )
      .get(wikiId, projectKey);
    if (row) return row;
  }
  if (name) {
    const row = db
      .prepare(
        'SELECT wiki_id, project_key, service_id, team_id, name, body, summary, updated_at FROM wiki_pages WHERE name = ? AND project_key = ?',
      )
      .get(name, projectKey);
    if (row) return row;
  }
  return null;
}

/**
 * BFS walk of the wiki link graph starting from a seed page.
 * Returns the visited nodes (in BFS order) plus every edge traversed.
 *
 * `max_hops` caps the depth (default 2). `kinds` filters which edge
 * kinds are walked (default = all). The seed is included in the
 * visited set even when no outgoing edges exist.
 */
export function traverseWiki(db, projectKey, seedId, { max_hops = 2, kinds = null } = {}) {
  const cap = Math.max(0, Math.min(20, max_hops));
  const kindList =
    Array.isArray(kinds) && kinds.length > 0
      ? kinds.filter((k) => WIKI_LINK_KIND_SET.has(k))
      : [...WIKI_LINK_KIND_SET];
  if (kindList.length === 0) {
    return { nodes: [], edges: [] };
  }
  const visited = new Map(); // wiki_id → page row
  const seenEdges = []; // {from, to, kind}
  const queue = [{ id: seedId, depth: 0 }];

  // Seed row, even if it doesn't exist (degenerate case — surfaces as
  // empty visit but no error).
  const seedRow = db
    .prepare(
      'SELECT wiki_id, name, summary, updated_at FROM wiki_pages WHERE wiki_id = ? AND project_key = ?',
    )
    .get(seedId, projectKey);
  if (seedRow) visited.set(seedId, seedRow);

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= cap) continue;
    const placeholders = kindList.map(() => '?').join(',');
    const edges = db
      .prepare(
        `SELECT from_wiki_id, to_wiki_id, kind FROM wiki_links
         WHERE project_key = ? AND from_wiki_id = ?
           AND kind IN (${placeholders})`,
      )
      .all(projectKey, id, ...kindList);
    for (const e of edges) {
      seenEdges.push({ from: e.from_wiki_id, to: e.to_wiki_id, kind: e.kind });
      // Skip unresolved (pending:) targets — the user will see them
      // as dangling edges in the dashboard and can chase them once
      // the target page lands.
      if (typeof e.to_wiki_id === 'string' && e.to_wiki_id.startsWith('pending:')) continue;
      if (visited.has(e.to_wiki_id)) continue;
      const targetRow = db
        .prepare(
          'SELECT wiki_id, name, summary, updated_at FROM wiki_pages WHERE wiki_id = ? AND project_key = ?',
        )
        .get(e.to_wiki_id, projectKey);
      if (!targetRow) continue;
      visited.set(e.to_wiki_id, targetRow);
      queue.push({ id: e.to_wiki_id, depth: depth + 1 });
    }
  }
  return { nodes: [...visited.values()], edges: seenEdges };
}

/**
 * List every page that links TO the given wiki_id (incoming edges).
 * Returns an array of {wiki_id, name, kind} for each edge.
 */
export function backlinksWiki(db, projectKey, wikiId, { kinds = null } = {}) {
  const kindList =
    Array.isArray(kinds) && kinds.length > 0
      ? kinds.filter((k) => WIKI_LINK_KIND_SET.has(k))
      : null;
  let rows;
  if (kindList && kindList.length > 0) {
    const placeholders = kindList.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT l.from_wiki_id, l.kind, p.name
         FROM wiki_links l
         LEFT JOIN wiki_pages p ON p.wiki_id = l.from_wiki_id AND p.project_key = l.project_key
         WHERE l.project_key = ? AND l.to_wiki_id = ?
           AND l.kind IN (${placeholders})
         ORDER BY p.name ASC, l.kind ASC`,
      )
      .all(projectKey, wikiId, ...kindList);
  } else {
    rows = db
      .prepare(
        `SELECT l.from_wiki_id, l.kind, p.name
         FROM wiki_links l
         LEFT JOIN wiki_pages p ON p.wiki_id = l.from_wiki_id AND p.project_key = l.project_key
         WHERE l.project_key = ? AND l.to_wiki_id = ?
         ORDER BY p.name ASC, l.kind ASC`,
      )
      .all(projectKey, wikiId);
  }
  return rows;
}
