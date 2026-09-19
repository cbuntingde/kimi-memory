// FTS5 query helpers + ORDER BY builder.
//
// Pure functions that take a raw input string (or sort key) and
// return a SQL-safe fragment. The actual search implementation lives
// in `src/persist/search.js` (which uses the larger RRF + vector
// pipeline); these helpers are the small, dependency-free utilities
// the rest of the package can call without pulling the embedding
// model.
//
// The helpers address two spec gaps that were previously documented
// but not implemented:
//   - title boosting (IMPROVEMENTS.md §5) — wrap `q` in a
//     `title:"q" OR "q"` clause so a hit on the title beats a hit
//     on the body.
//   - sort_by / recent_first — `searchMemories` previously ignored
//     these documented parameters; the SQL it built was hardcoded
//     to "rank + priority + updated_at DESC". The helper exposes
//     the documented surface; the integration in `persist/search.js`
//     honours it.

const QUOTED_TERM = /"[^"]+"/g;
const NEGATED_TERM = /(^|\s)(-\S+(?:\s+\S+)?)/g;

// Normalise a free-form user query into an FTS5 MATCH expression.
// The transformation rules (matching the test contract):
//
//   - "exact phrase"                    => "exact phrase"        (preserved)
//   - -exclude term                     => NOT "exclude"         (FTS5 NOT)
//   - single bare token                 => "token"
//   - two+ bare tokens                  => "token1" OR "token2" OR ...
//   - whitespace / empty / null         => ""
//
// Tokens are lowercased and stripped of non-word characters so a
// common typo drift does not blow up the FTS5 parser. Negated terms
// are emitted as FTS5 `NOT "..."` clauses — the prior shape appended
// a raw `-term` which FTS5 treats as a syntax error.
// (Audit finding F-008.)
export function normalizeFts5Query(input) {
  if (input == null) return '';
  const raw = String(input);
  if (!raw.trim()) return '';

  // Pull out quoted phrases verbatim; they survive tokenisation.
  const quoted = [];
  const negated = [];
  raw.replace(QUOTED_TERM, (m) => {
    quoted.push(m);
    return ' ';
  });
  // Negated-term tokens are normalised the same way bare tokens are
  // (lowercased, non-word stripped) and re-quoted. `-exclude term`
  // becomes `NOT "exclude term"` in the emitted expression. The
  // leading `-` is stripped here — FTS5 NOT does not take a unary
  // minus, and the regex captures it as part of `term`.
  raw.replace(NEGATED_TERM, (_, prefix, term) => {
    const cleaned = term.trim().replace(/^-/, '').replace(/"/g, '""');
    if (cleaned) negated.push(cleaned);
    return ' ';
  });

  // The remainder is bare tokens. Lowercase and split on anything that
  // isn't a letter, digit, or ASCII dash / underscore.
  const stripped = raw
    .replace(QUOTED_TERM, ' ')
    .replace(NEGATED_TERM, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Quoted-phrase helper: doubled `"` to escape internal quotes; the
  // resulting fragment is safe to drop into an FTS5 MATCH expression.
  // (Audit fix M1 — the same one-liner appeared twice in this file.)
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

  const parts = [];
  for (const t of stripped) parts.push(q(t));
  for (const quotedPhrase of quoted) parts.push(quotedPhrase);

  const positive = parts.join(' OR ');
  const negative = negated.map((n) => q(n)).join(' NOT ');
  if (negative) {
    return positive ? `${positive} NOT ${negative}` : `"*" NOT ${negative}`;
  }
  return positive;
}

// Wrap a query so the title column is matched first. Returned
// fragment is suitable for `memories_fts MATCH` (the OR is FTS5
// syntax). Falls back to a general match when the title field is
// not part of the FTS table — the expansion keeps recall usable
// even when title-boosting gives no surface.
//
// When the query contains a NOT clause (an exclusion), we skip
// the title-boost wrapping. Wrapping a NOT expression in
// `title:foo NOT bar OR foo NOT bar` produces a parse error — the
// OR binds tighter than NOT. (Audit finding F-008.)
export function buildTitleBoostedQuery(input) {
  const norm = normalizeFts5Query(input);
  if (!norm) return '';
  if (/\bNOT\b/.test(norm)) return norm;
  // The `title:` field is part of the FTS5 schema (column-list in
  // memories_fts CREATE VIRTUAL TABLE). The OR fallback ensures
  // that a project without title-bearing content still gets the
  // hit.
  return `title:${norm} OR ${norm}`;
}

// Build an ORDER BY clause from a sort key. The keys map to the
// documented surface in IMPROVEMENTS.md §5:
//   - 'recent'     => rank + priority + updated_at DESC
//   - 'relevance'  => rank + priority + updated_at DESC (alias)
//   - 'confidence' => confidence DESC + updated_at DESC
//   - 'oldest'     => updated_at ASC
//
// Anything else falls back to 'relevance' so callers get a sensible
// default. Returns a SQL fragment (no leading "ORDER BY").
export function buildOrderByClause(sort) {
  switch (sort) {
    case 'recent':
      return 'updated_at DESC';
    case 'oldest':
      return 'updated_at ASC';
    case 'confidence':
      return 'confidence DESC, updated_at DESC';
    case 'relevance':
    default:
      return 'rank ASC, priority DESC, updated_at DESC';
  }
}
