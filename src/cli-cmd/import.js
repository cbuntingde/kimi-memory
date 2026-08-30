// CLI: import memories from a JSON export file.
//
//   node src/cli.js import <input-file>  [--cwd <path>] [--scope project|global|all]
//                                       [--merge|--replace [--yes]]
//
// Routes every imported row through saveMemory so the v10 ACL columns
// (visibility, shared_with, team_id, agent_id, user_id, session_id,
// task_id, tier, persona_id, is_session_focus, stability_days,
// last_rehearsed_at), the FTS mirror, and the synthesizes[] edges all
// land in lockstep with the live DB. _embed:false disables the per-row
// embedding microtask; the operator can run `npm run backfill-embeddings`
// after import if they want the recall vector populated.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { openDb, closeDb, saveMemory, assertNoSecret } from '../persist.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { homeDir, resolveCwd } from '../cli/lib.js';

export async function cmdImport(args) {
  const home = homeDir(args);
  const inFile = args.positional[0];
  if (!inFile) {
    process.stderr.write('error: input file path is required\n');
    process.exit(1);
  }
  // Cap the import file size to avoid OOM on a hand-crafted or
  // accidentally-truncated file. 50 MB is well above any export the
  // plugin itself can produce.
  // (Audit finding B1-5.)
  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
  try {
    const st = statSync(inFile);
    if (st.size > MAX_IMPORT_BYTES) {
      process.stderr.write(
        `error: import file too large (${st.size} bytes; max ${MAX_IMPORT_BYTES})\n`,
      );
      process.exit(2);
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      process.stderr.write(`error: import file not found: ${inFile}\n`);
      process.exit(1);
    }
    process.stderr.write(`error: cannot stat import file: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for import\n');
    process.exit(1);
  }
  const scope = (args.flags.scope || 'project').toString();
  const replace = !!args.flags.replace;
  const yes = !!args.flags.yes;

  if (!['project', 'global', 'all'].includes(scope)) {
    process.stderr.write(`error: invalid scope: ${scope}\n`);
    process.exit(1);
  }

  if (replace && !yes) {
    process.stderr.write('error: refusing to replace without --yes flag\n');
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(inFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`error reading/parsing import file: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }

  if (!doc.scopes) {
    process.stderr.write('error: invalid export file (no scopes)\n');
    process.exit(1);
  }

  // Defence-in-depth: scan every imported memory up-front for known
  // credential shapes. saveMemory() also runs the same scan on each
  // row, but a single reject-on-first-hit here gives the operator a
  // clean summary before any writes hit the DB.
  // KIMI_MEMORY_SECRET_SCAN=off bypasses this for fixture imports.
  // (Production-readiness F-1.)
  if (process.env.KIMI_MEMORY_SECRET_SCAN !== 'off') {
    const all = [];
    if (doc.scopes.project?.memories) all.push(...doc.scopes.project.memories);
    if (doc.scopes.global?.memories) all.push(...doc.scopes.global.memories);
    for (const m of all) {
      try {
        assertNoSecret({
          title: m.title,
          content: m.content,
          tags: m.tags,
          metadata: m.metadata,
          provenance: m.provenance,
        });
      } catch (e) {
        if (e && e.code === 'KIMI_MEMORY_SECRET_DETECTED') {
          process.stderr.write(
            `error: refusing to import — memory ${m.id}: ${e.message}\n` +
              `Set KIMI_MEMORY_SECRET_SCAN=off to bypass for fixture imports.\n`,
          );
          process.exit(1);
        }
        throw e;
      }
    }
  }

  let count = 0;
  if ((scope === 'project' || scope === 'all') && doc.scopes.project) {
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    const db = openDb(dbPath);
    if (replace) {
      db.prepare('DELETE FROM memories WHERE project_key = ?').run(key);
      db.prepare('DELETE FROM working_memory WHERE project_key = ?').run(key);
      db.prepare('DELETE FROM memory_synthesizes WHERE project_key = ?').run(key);
    }
    for (const mem of doc.scopes.project.memories || []) {
      try {
        saveMemory(db, key, {
          id: mem.id,
          type: mem.type,
          title: mem.title || '',
          content: mem.content || '',
          tags: mem.tags || [],
          metadata: mem.metadata || {},
          provenance: mem.provenance || {},
          confidence: mem.confidence,
          status: mem.status,
          priority: mem.priority,
          supersedes: mem.supersedes,
          expires_at: mem.expires_at,
          synthesizes: Array.isArray(mem.synthesizes) ? mem.synthesizes : [],
          visibility: mem.visibility,
          shared_with: mem.shared_with,
          team_id: mem.team_id,
          agent_id: mem.agent_id,
          user_id: mem.user_id,
          session_id: mem.session_id,
          task_id: mem.task_id,
          tier: mem.tier,
          persona_id: mem.persona_id,
          is_session_focus: mem.is_session_focus,
          stability_days: mem.stability_days,
          last_rehearsed_at: mem.last_rehearsed_at,
          created_at: mem.created_at,
          updated_at: mem.updated_at,
          access_count: mem.access_count,
          last_accessed_at: mem.last_accessed_at,
          processing_status: mem.processing_status,
          _embed: false,
        });
        count++;
      } catch (e) {
        process.stderr.write(`warning: failed to import memory ${mem.id}: ${e.message}\n`);
      }
    }
    for (const wm of doc.scopes.project.working_memory || []) {
      try {
        db.prepare(
          'INSERT OR REPLACE INTO working_memory (slot, project_key, value, updated_at) VALUES (?, ?, ?, ?)',
        ).run(wm.slot, key, wm.value, wm.updated_at || new Date().toISOString());
      } catch (e) {
        process.stderr.write(
          `warning: failed to import working_memory slot ${wm.slot}: ${e.message}\n`,
        );
      }
    }
    closeDb(dbPath);
  }

  if ((scope === 'global' || scope === 'all') && doc.scopes.global) {
    const gPath = globalDbPath(home);
    const db = openDb(gPath);
    if (replace) {
      db.prepare('DELETE FROM memories WHERE project_key = ?').run(GLOBAL_PROJECT_KEY);
      db.prepare('DELETE FROM memory_synthesizes WHERE project_key = ?').run(GLOBAL_PROJECT_KEY);
    }
    for (const mem of doc.scopes.global.memories || []) {
      try {
        saveMemory(db, GLOBAL_PROJECT_KEY, {
          id: mem.id,
          type: mem.type,
          title: mem.title || '',
          content: mem.content || '',
          tags: mem.tags || [],
          metadata: mem.metadata || {},
          provenance: mem.provenance || {},
          confidence: mem.confidence,
          status: mem.status,
          priority: mem.priority,
          supersedes: mem.supersedes,
          expires_at: mem.expires_at,
          synthesizes: Array.isArray(mem.synthesizes) ? mem.synthesizes : [],
          visibility: mem.visibility,
          shared_with: mem.shared_with,
          team_id: mem.team_id,
          agent_id: mem.agent_id,
          user_id: mem.user_id,
          session_id: mem.session_id,
          task_id: mem.task_id,
          tier: mem.tier,
          persona_id: mem.persona_id,
          is_session_focus: mem.is_session_focus,
          stability_days: mem.stability_days,
          last_rehearsed_at: mem.last_rehearsed_at,
          created_at: mem.created_at,
          updated_at: mem.updated_at,
          access_count: mem.access_count,
          last_accessed_at: mem.last_accessed_at,
          processing_status: mem.processing_status,
          _embed: false,
        });
        count++;
      } catch (e) {
        process.stderr.write(`warning: failed to import global memory ${mem.id}: ${e.message}\n`);
      }
    }
    closeDb(gPath);
  }

  process.stdout.write(`imported ${count} items from ${inFile}\n`);
}
