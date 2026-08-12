// Barrel — re-exports the public API of every sibling module.
//
// When the original src/persist.js was a single 3423-line file, every
// call site imported from it directly. This barrel preserves that
// contract so the refactor is invisible to callers: `import { ... } from
// './persist.js'` still works, and the same names map to the same
// implementations (now each in its own focused module).

// ----- Connection / schema -----
export {
  openDb,
  closeDb,
  openSharedDb,
  sharedDataDir,
  sharedDbPath,
  SHARED_DIR_NAME,
  SHARED_PROJECT_KEY,
} from './connection.js';

// ----- Memory CRUD + helpers + synthesis + status -----
export {
  memoryId,
  rowToMemory,
  saveMemory,
  saveMemoryBulk,
  getMemory,
  listMemories,
  deleteMemory,
  listConclusionsFor,
  getParents,
  mergeMemory,
  memoryCounts,
  projectStatus,
  resetProjectDryRunCounts,
  promotePendingRows,
  flushEmbeddings,
} from './memories.js';

// ----- Search / recall / backfill -----
export {
  combineRrfScores,
  searchMemories,
  similarMemories,
  backfillEmbeddings,
} from './search.js';

// ----- Reinforcement / decay -----
export { reinforceMemory, reinforceIfStale, decayMemories } from './reinforce.js';

// ----- Typed edges -----
export {
  validEdgeKinds,
  isValidEdgeKind,
  linkMemory,
  unlinkMemory,
  listEdges,
} from './edges.js';

// ----- Visibility / tier / share -----
export {
  validVisibilityLevels,
  validTiers,
  isValidTier,
  shareMemory,
  setMemoryTier,
  promoteMemory,
  demoteMemory,
  listTierHistory,
} from './share.js';

// ----- Skill triggers + invocations -----
export {
  matchSkillTriggers,
  recordSkillInvocation,
  updateSkillInvocationStats,
  listSkillMemories,
} from './skills.js';

// ----- Project-scoped data: working memory, conversations, paths, reset -----
export {
  setWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  listWorkingMemory,
  upsertConversation,
  getConversation,
  listConversations,
  searchConversationEvents,
  getConversationEvents,
  recordConversationEvent,
  updateConversationProgress,
  loadIngestState,
  saveIngestState,
  recordProjectPath,
  listProjectPaths,
  detectReclone,
  resetProject,
} from './project.js';

// ----- Re-exports from tool-registry.js and codegraph.js -----
export {
  buildToolRegistry,
  filterToolRegistry,
  extractSymbolsFromText,
  extractCodeGraph,
  buildCodeGraphEdges,
  queryMemoryGraph,
} from './re-exports.js';
