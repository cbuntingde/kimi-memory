// Enhanced search utilities for kimi-memory.
// Provides query normalization, title boosting, and flexible sorting.

// Normalize FTS5 query: escape special chars, support basic operators.
// Allows: "exact phrase", -exclude, term1 term2
export function normalizeFts5Query(query) {
  if (!query || typeof query !== 'string') return '';
  
  // Already contains FTS5 operators or quoted phrase? Use as-is.
  if (query.includes('"') || query.includes('-') || query.includes('(') || query.includes(')')) {
    return query;
  }
  
  // Simple query: split by spaces and rejoin (basic tokenization).
  // Each term will match with OR logic by default in FTS5.
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return terms.join(' OR ');
}

// Build an FTS5 query that boosts title matches over content matches.
// SQLite FTS5 doesn't support explicit weighting, but we can use column
// syntax to prioritize title: `title : query` matches are ranked higher.
export function buildTitleBoostedQuery(query) {
  const normalized = normalizeFts5Query(query);
  // In FTS5, column-qualified searches are ranked before general matches.
  // Return a query that prefers title hits: "title:term1 title:term2 ... OR term1 term2 ..."
  const titleTerms = normalized
    .split(' OR ')
    .map((t) => `title:${t.trim()}`)
    .join(' OR ');
  return `${titleTerms} OR ${normalized}`;
}

// Sort enum validation.
const VALID_SORTS = ['relevance', 'recent', 'confidence', 'priority'];
export function isValidSort(sort) {
  return VALID_SORTS.includes(sort);
}

// Build ORDER BY clause based on sort preference.
export function buildOrderByClause(sort = 'relevance') {
  switch (sort) {
    case 'recent':
      return 'ORDER BY updated_at DESC, rank';
    case 'confidence':
      return 'ORDER BY confidence DESC, rank';
    case 'priority':
      return 'ORDER BY priority DESC, rank';
    case 'relevance':
    default:
      return 'ORDER BY rank, updated_at DESC';
  }
}

// Build a ranked FTS5 search query with sorting.
// Returns { query, orderClause, titleBoosted }
export function buildSearchQuery(userQuery, sortBy = 'relevance') {
  if (!userQuery || typeof userQuery !== 'string') {
    return { query: '', orderClause: buildOrderByClause(sortBy), titleBoosted: false };
  }

  // For "title boost" strategy, we use column-qualified terms.
  // This helps surface title matches before content matches.
  const titleBoostedQuery = buildTitleBoostedQuery(userQuery);
  const orderClause = buildOrderByClause(sortBy);

  return {
    query: titleBoostedQuery,
    orderClause,
    titleBoosted: true,
    userQuery,
  };
}

// Helper to extract snippet from memory content for preview.
export function getSnippet(content, maxChars = 100) {
  if (!content) return '';
  const trimmed = String(content).trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '...';
}

// Check if a query appears to be requesting negation (e.g., "-word").
export function hasNegation(query) {
  if (!query) return false;
  return /\s-\w+/.test(query);
}

// Check if a query uses phrase search (quoted).
export function hasPhrase(query) {
  if (!query) return false;
  return /"[^"]*"/.test(query);
}

// Query suggestion based on what the user typed.
export function suggestQueryFix(query) {
  if (!query) return null;
  
  const suggestions = [];
  
  if (hasNegation(query)) {
    suggestions.push({
      tip: 'Negation supported: use -word to exclude',
      example: 'deploy -test',
    });
  }
  
  if (hasPhrase(query)) {
    suggestions.push({
      tip: 'Phrase search supported: results must contain exact phrase',
      example: '"build process"',
    });
  }
  
  if (!hasPhrase(query) && !hasNegation(query)) {
    suggestions.push({
      tip: 'Try quoted phrases for exact matches: "your phrase here"',
      example: '"specific decision"',
    });
  }
  
  return suggestions.length > 0 ? suggestions : null;
}
