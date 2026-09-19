// Conversation-archive MCP handlers (4 tools, project-scoped only).
//
//   conversation_list    — paginated list of ingested sessions
//   conversation_get     — fetch session metadata + a slice of events
//   conversation_search  — FTS5 search across conversation_events
//   conversation_ingest  — pull one wire.jsonl into the project DB
//
// The ingest path uses src/mcp/lib/ingest.js, which holds the
// shared walker + cursor-state logic extracted from the previous
// inline `ingestOne` in server.js.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateLimit, validateOffset, validateRole } from '../../validation.js';
import {
  listConversations,
  getConversation,
  getConversationEvents,
  searchConversationEvents,
} from '../../persist.js';
import { ingestOne } from '../lib/ingest.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- conversation_list ----
  registerTool(
    server,
    D.conversation_list,
    async (args, ctx) => {
      const lim = validateLimit(args.limit, 1, 500, 50);
      if (!lim.ok) throw toolError(lim.error);
      const items = listConversations(ctx.db, ctx.projectKey, { limit: lim.value });
      return { operation: 'conv_list', items, count: items.length, project_key: ctx.projectKey };
    },
    handlers,
    home,
  );

  // ---- conversation_get ----
  registerTool(
    server,
    D.conversation_get,
    async (args, ctx) => {
      if (!args.session_id) throw toolError('session_id is required');
      const lim = validateLimit(args.limit, 1, 1000, 200);
      if (!lim.ok) throw toolError(lim.error);
      const off = validateOffset(args.since);
      if (!off.ok) throw toolError(off.error);
      const meta = getConversation(ctx.db, ctx.projectKey, args.session_id);
      const events = getConversationEvents(ctx.db, ctx.projectKey, args.session_id, {
        limit: lim.value,
        since: off.value,
      });
      return {
        operation: 'conv_get',
        conversation: meta,
        events,
        count: events.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- conversation_search ----
  registerTool(
    server,
    D.conversation_search,
    async (args, ctx) => {
      if (!args.query) throw toolError('query is required');
      const lim = validateLimit(args.limit, 1, 200, 20);
      if (!lim.ok) throw toolError(lim.error);
      const role = args.role ? validateRole(args.role) : { ok: true, value: null };
      if (!role.ok) throw toolError(role.error);
      const items = searchConversationEvents(ctx.db, ctx.projectKey, args.query, {
        sessionId: args.session_id,
        role: role.value,
        limit: lim.value,
      });
      return {
        operation: 'conv_search',
        items,
        count: items.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- conversation_ingest ----
  registerTool(
    server,
    D.conversation_ingest,
    async (args, ctx) => {
      const r = await ingestOne({
        home,
        db: ctx.db,
        projectKey: ctx.projectKey,
        cwd: ctx.cwd,
        sessionId: args.session_id,
        workDirKey: args.work_dir_key,
        force: !!args.force,
      });
      return { operation: 'conv_ingest', ...r };
    },
    handlers,
    home,
  );
}
