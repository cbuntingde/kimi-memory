// Re-exports from sibling modules (tool-registry, codegraph).
//
// These live in their own files to avoid circular dependencies
// (server.js imports from persist.js, and tool-registry.js was
// carved out of the original server.js/persist.js shared surface).
// The tests at tests/27-tools-lazy.test.js and tests/26-codegraph.test.js
// import these directly from `'../src/persist.js'`, which is why the
// re-exports live here.

// `buildToolRegistry` and `filterToolRegistry` are implemented in the
// standalone `./tool-registry.js` module so both `persist.js` and
// `server.js` can import them without creating a circular dependency
// (server.js already imports from persist.js). The test
// `tests/27-tools-lazy.test.js` imports them directly from persist.js,
// which is why the re-exports live here.
export { buildToolRegistry, filterToolRegistry } from '../tool-registry.js';

// Re-export the CodeGraph helpers (Phase 5). Implementation lives in
// src/codegraph.js; re-exporting here so the scaffold test at
// tests/26-codegraph.test.js can keep its existing
// `import { extractSymbolsFromText, … } from '../src/persist.js'`
// contract.
export {
  extractSymbolsFromText,
  extractCodeGraph,
  buildCodeGraphEdges,
  queryMemoryGraph,
} from '../codegraph.js';
