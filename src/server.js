// MCP server orchestrator.
//
// Wires up the per-domain handler modules under src/mcp/handlers/
// into a single McpServer instance. Each module exports
// `register(server, handlers, home)` and calls `registerTool(...)` for
// each tool it owns. The wrapper at src/mcp/lib/register-tool.js
// provides the boilerplate that used to live inline here:
// `resolveProjectRoot + validateScope + openScopeDb + try/catch +
// ok/textError`. Each per-domain handler is now a plain async
// (args, ctx) => result function.
//
// Re-exports TOOL_DEFS so the proxy can read the same array without
// importing the orchestrator directly.
//
// Storage model (unchanged):
//   - per-project durable + working memory + conversations live under
//     <kimiHome>/kimi-memory/<projectKey>/memory.sqlite
//   - global/user durable memory lives under
//     <kimiHome>/kimi-memory/_global/memory.sqlite
//   - shared hook diagnostics live under
//     <kimiHome>/kimi-memory/_diagnostics/hooks.log
//
// Scope semantics on durable-memory tools (unchanged):
//   - memory_save / memory_update / memory_delete:
//       scope ∈ { project | global }, default = project
//   - memory_recall / memory_list / memory_get:
//       scope ∈ { project | global | all }, default = all
//   - working_memory_* and conversation_* tools are explicitly project-
//     scoped; no scope argument is accepted.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { kimiHome } from './util.js';
import { TOOL_DEFS } from './mcp/tool-defs.js';

import { register as registerMemoryCrud } from './mcp/handlers/memory-crud.js';
import { register as registerShare } from './mcp/handlers/share.js';
import { register as registerWorkingMemory } from './mcp/handlers/working-memory.js';
import { register as registerConversations } from './mcp/handlers/conversations.js';
import { register as registerEdges } from './mcp/handlers/edges.js';
import { register as registerMaintenance } from './mcp/handlers/maintenance.js';
import { register as registerDream } from './mcp/handlers/dream.js';
import { register as registerDreaming } from './mcp/handlers/dreaming.js';
import { register as registerAcl } from './mcp/handlers/acl.js';
import { register as registerTier } from './mcp/handlers/tier.js';
import { register as registerCodegraph } from './mcp/handlers/codegraph.js';
// src/mcp/tool-defs.js; per-domain handler modules look tools up by
// name via the TOOL_DEFS_BY_NAME sibling export.
export { TOOL_DEFS };

export function makeServer({ kimiHomeDir, pluginRootDir, logger } = {}) {
  const home = kimiHomeDir || kimiHome();
  const root = pluginRootDir || process.cwd();
  const log =
    logger ||
    ((...a) => {
      try {
        process.stderr.write('[kimi-memory] ' + a.join(' ') + '\n');
      } catch {
        /* ignore */
      }
    });

  // Server version is read from package.json at startup so it can
  // never drift from the manifest. tests/06-manifest.test.js asserts
  // the package.json / package-lock.json / kimi.plugin.json triple
  // stays in lockstep; this read keeps the MCP `initialize`
  // response (which Kimi logs at plugin load) honest.
  //
  // createRequire + import.meta.url is anchored on src/server.js
  // itself, not the importer — so whether makeServer is invoked by
  // src/mcp/main.js, src/proxy/server.js, or a test, the resolution
  // always lands on the same package.json at the plugin root.
  const require = createRequire(import.meta.url);
  const { version: pkgVersion } = require('../package.json');
  const server = new McpServer({ name: 'kimi-memory', version: pkgVersion });

  // Per-tool handlers populate this Map<name, async fn> as they
  // register. The proxy reads it directly instead of reaching into
  // the SDK's private `_registeredTools` / `_tools` fields — see
  // src/proxy/server.js dispatchTool().
  const handlers = new Map();

  // Always-on domain modules (25 tools): memory CRUD + working memory
  // + conversations + edges + maintenance + dream.
  registerMemoryCrud(server, handlers, home);
  registerShare(server, handlers, home);
  registerWorkingMemory(server, handlers, home);
  registerConversations(server, handlers, home);
  registerEdges(server, handlers, home);
  registerMaintenance(server, handlers, home);
  registerDreaming(server, handlers, home);
  registerDream(server, handlers, home);
  // Legacy subsystems (20 tools): ACL/visibility, tier/persona,
  // codegraph. Each module self-gates on
  // KIMI_MEMORY_LEGACY_SUBSYSTEMS and returns early when the env var
  // is 'off'. The wiki group was removed in v14 (no gate needed —
  // it's gone from TOOL_DEFS entirely). See AGENTS.md §Subsystem
  // deprecation.
  registerAcl(server, handlers, home);
  registerTier(server, handlers, home);
  registerCodegraph(server, handlers, home);

  return { server, handlers, home, pluginRoot: root, logger: log };
}
