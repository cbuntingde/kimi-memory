// CLI: ACL grant / revoke / list.
//
//   acl list   <memory-id> [--cwd <path>] [--scope project|global] [--json]
//   acl grant  <memory-id> --principal-kind <user|team|role|agent> --principal-id <id>
//            [--cwd <path>] [--scope project|global] [--json]
//   acl revoke <memory-id> --principal-kind <k> --principal-id <id>
//            [--cwd <path>] [--scope project|global] [--json]
import { existsSync } from 'node:fs';
import { openDb, closeDb } from '../persist.js';
import { grantMemoryAcl, revokeMemoryAcl, listMemoryAcls } from '../acl.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdAcl(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  const sub = (args.positional[0] || '').toString();
  const memId = (args.positional[1] || '').toString();
  const scopeRaw = args.flags.scope ? String(args.flags.scope) : 'project';
  const asJson = !!args.flags.json;

  if (!sub) {
    process.stderr.write('error: acl requires a subcommand (list|grant|revoke)\n');
    process.exit(1);
  }
  if (!memId) {
    process.stderr.write('error: acl requires a memory id (positional)\n');
    process.exit(1);
  }
  if (scopeRaw !== 'project' && scopeRaw !== 'global') {
    process.stderr.write('error: --scope must be project or global\n');
    process.exit(1);
  }
  if (scopeRaw === 'project' && !cwd) {
    process.stderr.write('error: --cwd is required for --scope project\n');
    process.exit(1);
  }
  const key = scopeRaw === 'global' ? GLOBAL_PROJECT_KEY : deriveProjectKey(cwd);
  const dbPath = scopeRaw === 'global' ? globalDbPath(home) : projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write(`note: ${scopeRaw} DB does not exist yet (${dbPath})\n`);
    process.exit(0);
  }
  const db = openDb(dbPath);

  try {
    if (sub === 'list') {
      const items = listMemoryAcls(db, key, memId);
      const out = { operation: 'acl_list', memory_id: memId, items, count: items.length };
      if (asJson) {
        emitJson(out);
      } else {
        process.stdout.write(`memory_id=${memId}\n`);
        process.stdout.write(`count=${items.length}\n`);
        for (const it of items) {
          process.stdout.write(
            `grant=${it.principal_kind}:${it.principal_id} granted_at=${it.granted_at}\n`,
          );
        }
      }
      closeDb();
      return;
    }

    if (sub === 'grant') {
      const kindRaw = args.flags['principal-kind'] || args.flags.principal_kind;
      const idRaw = args.flags['principal-id'] || args.flags.principal_id;
      if (!kindRaw || !idRaw) {
        process.stderr.write('error: acl grant requires --principal-kind and --principal-id\n');
        process.exit(1);
      }
      try {
        const row = grantMemoryAcl(db, key, memId, String(kindRaw), String(idRaw));
        const out = { operation: 'acl_granted', grant: row };
        if (asJson) {
          emitJson(out);
        } else {
          process.stdout.write(`memory_id=${memId}\n`);
          process.stdout.write(`granted=${row.principal_kind}:${row.principal_id}\n`);
          process.stdout.write(`granted_at=${row.granted_at}\n`);
        }
      } catch (e) {
        process.stderr.write(`error: ${e.message}\n`);
        process.exit(1);
      }
      closeDb();
      return;
    }

    if (sub === 'revoke') {
      const kindRaw = args.flags['principal-kind'] || args.flags.principal_kind;
      const idRaw = args.flags['principal-id'] || args.flags.principal_id;
      if (!kindRaw || !idRaw) {
        process.stderr.write('error: acl revoke requires --principal-kind and --principal-id\n');
        process.exit(1);
      }
      const removed = revokeMemoryAcl(db, key, memId, String(kindRaw), String(idRaw));
      const out = {
        operation: 'acl_revoked',
        memory_id: memId,
        principal_kind: String(kindRaw),
        principal_id: String(idRaw),
        removed,
      };
      if (asJson) {
        emitJson(out);
      } else {
        process.stdout.write(`memory_id=${memId}\n`);
        process.stdout.write(
          `principal=${out.principal_kind}:${out.principal_id}\nremoved=${removed}\n`,
        );
      }
      closeDb();
      return;
    }

    process.stderr.write(`error: unknown acl subcommand: ${sub}\n`);
    process.exit(1);
  } catch (e) {
    // Ensure the cached SQLite handle is released before the throw
    // bubbles to main(). The outer catch in main() also closes every
    // handle, but closing here keeps the throw path narrow so a
    // caller that catches at this layer doesn't leak the handle.
    // (Audit fix M12.)
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    throw e;
  }
}
