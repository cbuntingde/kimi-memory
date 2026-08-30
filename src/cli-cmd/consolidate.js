// CLI: Phase-1 inline consolidation. Runs the same pass the
// SessionStart hook runs, but synchronously + on demand. Useful for
// ops debugging and for testing changes without a session close.
//
//   consolidate run    [--cwd <path>] [--json]
//   consolidate status [--cwd <path>] [--json]
import path from 'node:path';
import { openDb, closeDb, saveMemory, linkMemory, mergeMemory } from '../persist.js';
import { runConsolidate } from '../consolidate.js';
import { deriveProjectKey } from '../project-key.js';
import { homeDir, resolveCwd, emitJson, safeJson } from '../cli/lib.js';

export async function cmdConsolidate(args) {
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for consolidate subcommands\n');
    process.exit(1);
  }
  const home = homeDir(args);
  const key = deriveProjectKey(cwd);
  const dbPath = path.join(home, 'kimi-memory', key, 'memory.sqlite');
  const db = openDb(dbPath);
  if (!db) {
    process.stderr.write(`error: could not open project DB at ${dbPath}\n`);
    process.exit(1);
  }
  const asJson = !!args.flags.json;
  const sub = (args.positional[0] || '').toString();
  if (!sub) {
    process.stderr.write('error: consolidate requires a subcommand (run|status)\n');
    process.exit(1);
  }
  try {
    if (sub === 'run') {
      const result = await runConsolidate({
        db,
        projectKey: key,
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      if (asJson) {
        emitJson({ operation: 'consolidate_run', project_key: key, result });
      } else {
        process.stdout.write(`scanned=${result.scanned}\n`);
        process.stdout.write(`clusters=${result.clusters}\n`);
        process.stdout.write(`saved=${result.saved}\n`);
        process.stdout.write(`merged=${result.merged}\n`);
        process.stdout.write(`mergeSkipped=${result.mergeSkipped}\n`);
        process.stdout.write(`dedup_pairs=${result.dedup_pairs || 0}\n`);
        process.stdout.write(`dedup_title_pairs=${result.dedup_title_pairs || 0}\n`);
        process.stdout.write(`dedup_near_dup_pairs=${result.dedup_near_dup_pairs || 0}\n`);
        process.stdout.write(`embedding_missing=${result.embedding_missing || 0}\n`);
        process.stdout.write(`skipped=${result.skipped || 0}\n`);
        process.stdout.write(`errors=${result.errors || 0}\n`);
      }
      closeDb();
      return;
    }
    if (sub === 'status') {
      const withEmbed = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE project_key=? AND status='active'
             AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
             AND embedding IS NOT NULL AND embedding_dim IS NOT NULL`,
        )
        .get(key).n;
      const withoutEmbed = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE project_key=? AND status='active'
             AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
             AND (embedding IS NULL OR embedding_dim IS NULL)`,
        )
        .get(key).n;
      const unclustered = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories m
           WHERE m.project_key=? AND m.status='active'
             AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))
             AND NOT EXISTS (
               SELECT 1 FROM memory_synthesizes s
               WHERE s.project_key=m.project_key AND s.child_id=m.id
             )`,
        )
        .get(key).n;
      const lastConsolidate = db
        .prepare(
          `SELECT id, summary, at FROM consolidation_runs
           WHERE project_key=? ORDER BY datetime(at) DESC LIMIT 1`,
        )
        .get(key);
      const lastDreamApply = db
        .prepare(
          `SELECT id, applied_at AS at FROM dream_jobs
           WHERE project_key=? AND status='applied' AND applied_at IS NOT NULL
           ORDER BY datetime(applied_at) DESC LIMIT 1`,
        )
        .get(key);
      const out = {
        project_key: key,
        embedding_coverage: { with_embedding: withEmbed, without_embedding: withoutEmbed },
        unclustered_active: unclustered,
        last_consolidate: lastConsolidate
          ? {
              id: lastConsolidate.id,
              at: lastConsolidate.at,
              summary: safeJson(lastConsolidate.summary),
            }
          : null,
        last_dream_apply: lastDreamApply ? { id: lastDreamApply.id, at: lastDreamApply.at } : null,
      };
      if (asJson) {
        emitJson({ operation: 'consolidate_status', ...out });
      } else {
        process.stdout.write(`with_embedding=${withEmbed}\n`);
        process.stdout.write(`without_embedding=${withoutEmbed}\n`);
        process.stdout.write(`unclustered_active=${unclustered}\n`);
        process.stdout.write(
          `last_consolidate_at=${out.last_consolidate ? out.last_consolidate.at : ''}\n`,
        );
        process.stdout.write(
          `last_dream_apply_at=${out.last_dream_apply ? out.last_dream_apply.at : ''}\n`,
        );
      }
      closeDb();
      return;
    }
    process.stderr.write(`error: unknown consolidate subcommand: ${sub}\n`);
    closeDb();
    process.exit(1);
  } catch (e) {
    process.stderr.write(`error: ${e && e.message ? e.message : String(e)}\n`);
    closeDb();
    process.exit(2);
  }
}
