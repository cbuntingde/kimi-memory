// registerTool — wraps every MCP tool with the boilerplate that used
// to live inline in src/server.js:
//
//   try {
//     const pr = resolveProjectRoot(args.cwd);
//     if (!pr.ok) return textError(pr.error);
//     const sc = validateScope(args.scope, { read: readScope });
//     if (!sc.ok) return textError(sc.error);
//     const db = openScopeDb({ cwd: pr.value, scope: sc.value, record: write });
//     return ok(await handler(args, { cwd: pr.value, scope: sc.value, db, projectKey }));
//   } catch (e) {
//     return textError(toError(e).error);
//   }
//
// Each per-tool handler is now a plain async function that returns
// its payload and throws `toolError(msg)` on failure. The wrapper
// catches ToolError specifically so the user-facing message is the
// thrown string verbatim (no double-encoding through toError).
//
// `handlers` (optional Map<name, async fn>) is populated with the
// post-resolve handler so the proxy can call a tool by name without
// going through the MCP dispatcher. This eliminates the proxy's
// dependency on the SDK's private `_registeredTools` / `_tools`
// fields.

import { resolveProjectRoot, validateScope, toError } from '../../validation.js';
import { openScopeDb, ok, textError } from './scope-db.js';
import { ToolError } from './tool-error.js';

export function registerTool(server, def, handler, handlers, home) {
  const {
    name,
    desc,
    input,
    write: writeIn = false,
    readScope = false,
    skipScopeValidation = false,
    skipDb = false,
  } = def;
  // Auto-detect read-vs-write scope semantics from the Zod schema.
  // A tool that exposes `scope: z.enum([project, global, all])` is a
  // read tool (the 'all' value is read-only). A tool that exposes
  // `scope: z.enum([project, global])` is a write tool. A tool whose
  // schema has no `scope` key is project-scoped only — the wrapper
  // skips scope validation entirely for those. The auto-detection
  // runs at registration; a handler may still override via the
  // `skipScopeValidation` flag (memory_prune uses a non-standard
  // scope vocabulary).
  let effectiveReadScope = readScope;
  let effectiveSkipScopeValidation = skipScopeValidation;
  if (input && Object.prototype.hasOwnProperty.call(input, 'scope')) {
    const values = enumValues(input.scope);
    if (values && values.includes('all')) effectiveReadScope = true;
  } else {
    effectiveSkipScopeValidation = true;
  }
  // Auto-detect write tools from the tool name. Write tools must
  // create the project / global DB on first use (or stamp the
  // project_paths row); read tools must NOT create the global DB on
  // a fresh install (audit fix B1-1/B2-5). A tool that does not
  // match any of the write-name patterns is treated as a read tool,
  // matching the prior inline behavior where only explicit write
  // tools passed `record: true` to openScopeDb.
  let write = writeIn;
  if (!write) {
    write = WRITE_NAME_PATTERNS.some((re) => re.test(name));
  }
  const wrapped = async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = effectiveSkipScopeValidation
        ? { ok: true, value: args.scope ?? null }
        : validateScope(args.scope, { read: effectiveReadScope });
      if (!sc.ok) return textError(sc.error);
      const dbHandle = skipDb
        ? { db: null, projectKey: null }
        : openScopeDb({
            cwd: pr.value,
            scope: sc.value,
            record: write,
            home,
          });
      const result = await handler(args, {
        cwd: pr.value,
        scope: sc.value,
        db: dbHandle.db,
        projectKey: dbHandle.projectKey,
      });
      return ok(result);
    } catch (e) {
      if (e instanceof ToolError) return textError(e.message);
      return textError(toError(e).error);
    }
  };
  server.tool(name, desc, input, wrapped);
  if (handlers) handlers.set(name, wrapped);
}

// Unwrap Zod's optional / nullable / default wrappers to reach the
// inner ZodEnum's values array. Zod stores the enum values on
// `_def.values` of the ZodEnum node; the wrapping nodes carry the
// wrapped schema in `_def.innerType` (or `_def.schema` for some
// variants). We loop until we find a ZodEnum or run out of wrappers.
function enumValues(zodNode) {
  let cur = zodNode;
  // eslint-disable-next-line no-constant-condition
  // (justification: walk-until-null loop over Zod wrapper chain; the loop
  // body always returns or reassigns `cur`, so the predicate is never
  // tautological at runtime — ESLint flags the literal shape only.)
  while (cur) {
    if (cur._def && cur._def.typeName === 'ZodEnum') return cur._def.values;
    if (cur._def && cur._def.innerType) {
      cur = cur._def.innerType;
      continue;
    }
    if (cur._def && cur._def.schema) {
      cur = cur._def.schema;
      continue;
    }
    return null;
  }
  return null;
}

// Patterns that mark a tool as a write tool (must create DB /
// stamp project_paths on call). Each entry matches the full tool
// name. Pattern matches the verb portion of the snake_case identifier.
const WRITE_NAME_PATTERNS = [
  /^memory_save(_bulk)?$/,
  /^memory_update$/,
  /^memory_delete$/,
  /^memory_reinforce$/,
  /^memory_link$/,
  /^memory_unlink$/,
  /^memory_merge$/,
  /^memory_set_tier$/,
  /^memory_promote$/,
  /^memory_demote$/,
  /^acl_grant$/,
  /^acl_revoke$/,
  /^acl_share_memory$/,
  /^codegraph_build_edges$/,
  /^dream_enqueue$/,
  /^dream_generate_proposals$/,
  /^dream_apply_job$/,
  /^dream_discard_job$/,
  // working_memory_set / working_memory_clear write to working_memory;
  // get does not. The pattern catches set + clear explicitly.
  /^working_memory_set$/,
  /^working_memory_clear$/,
  // conversation_ingest writes to conversation_events.
  /^conversation_ingest$/,
];
