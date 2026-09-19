// Backward-compatibility barrel. The persistence layer was split into
// focused modules under ./persist/; this file re-exports the public
// API so existing `import { ... } from './persist.js'` call sites
// keep working unchanged. New code should import from './persist/'
// (or specific files inside it) directly.
export * from './persist/index.js';
