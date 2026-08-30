// CLI: Phase-1 Dream consolidation subcommands. Mirror the MCP surface
// for ops debugging + scripted apply.
//
//   dream status   [--cwd <path>] [--json]
//   dream list     [--cwd <path>] [--status ...] [--json]
//   dream get      <job-id> [--cwd <path>] [--json]
//   dream enqueue  [--cwd <path>] [--json]
//   dream generate <job-id> [--cwd <path>] [--json]
//   dream apply    <job-id> [--cwd <path>] [--auto-apply-confidence N] [--json]
//   dream discard  <job-id> [--cwd <path>] [--reason <text>] [--json]
import { existsSync } from 'node:fs';
import { openDb, closeDb, saveMemory, linkMemory, mergeMemory } from '../persist.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  discardDreamJob,
  listJobs as listDreamJobs,
  listProposals as listDreamProposals,
  readJob as readDreamJob,
  buildDreamStatus,
} from '../dream.js';
import { deriveProjectKey, projectDbPath } from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdDream(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for dream subcommands\n');
    process.exit(1);
  }
  const asJson = !!args.flags.json;
  const sub = (args.positional[0] || '').toString();
  if (!sub) {
    process.stderr.write(
      'error: dream requires a subcommand (status|list|get|enqueue|generate|apply|discard)\n',
    );
    process.exit(1);
  }
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
    process.exit(0);
  }
  const db = openDb(dbPath);
  try {
    if (sub === 'status') {
      const status = buildDreamStatus(db, key);
      if (asJson) emitJson({ operation: 'dream_status', status });
      else {
        process.stdout.write(`label=${status.label}\n`);
        process.stdout.write(`queued=${status.queued}\n`);
        process.stdout.write(`ready=${status.ready}\n`);
        process.stdout.write(`applied=${status.applied}\n`);
        process.stdout.write(`failed=${status.failed}\n`);
        process.stdout.write(`cancelled=${status.cancelled}\n`);
      }
      closeDb();
      return;
    }
    if (sub === 'list') {
      const status = args.flags.status ? String(args.flags.status) : null;
      const items = listDreamJobs(db, key, { status, limit: 50 });
      if (asJson) emitJson({ operation: 'dream_list', items, count: items.length });
      else {
        for (const j of items) {
          process.stdout.write(
            `${j.id} status=${j.status} enqueued_at=${j.enqueued_at} updated_at=${j.updated_at}\n`,
          );
        }
      }
      closeDb();
      return;
    }
    if (sub === 'get') {
      const jobId = args.positional[1];
      if (!jobId) {
        process.stderr.write('error: dream get requires a job id\n');
        process.exit(1);
      }
      const job = readDreamJob(db, key, jobId);
      if (!job) {
        process.stderr.write(`not found: ${jobId}\n`);
        process.exit(1);
      }
      const proposals = listDreamProposals(db, key, jobId);
      if (asJson) emitJson({ operation: 'dream_get', job, proposals });
      else {
        process.stdout.write(`id=${job.id}\nstatus=${job.status}\n`);
        process.stdout.write(`enqueued_at=${job.enqueued_at}\n`);
        process.stdout.write(`ready_at=${job.ready_at || ''}\n`);
        process.stdout.write(`applied_at=${job.applied_at || ''}\n`);
        process.stdout.write(`error=${job.error || ''}\n`);
        process.stdout.write(`proposals=${proposals.length}\n`);
      }
      closeDb();
      return;
    }
    if (sub === 'enqueue') {
      const result = enqueueDreamJob(db, key, { triggered_by: 'cli' });
      if (asJson) emitJson({ operation: 'dream_enqueue', result });
      else process.stdout.write(`status=${result.status} job_id=${result.job_id || ''}\n`);
      closeDb();
      return;
    }
    if (sub === 'generate') {
      const jobId = args.positional[1];
      if (!jobId) {
        process.stderr.write('error: dream generate requires a job id\n');
        process.exit(1);
      }
      const result = await generateProposalsForJob(db, key, jobId, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      if (asJson) emitJson({ operation: 'dream_generate_proposals', result });
      else {
        process.stdout.write(`ok=${result.ok}\n`);
        if (result.result_counts) {
          process.stdout.write(
            `proposals_persisted=${result.result_counts.proposals_persisted || 0}\n`,
          );
          process.stdout.write(
            `proposals_dropped=${result.result_counts.proposals_dropped || 0}\n`,
          );
        }
      }
      closeDb();
      return;
    }
    if (sub === 'apply') {
      const jobId = args.positional[1];
      if (!jobId) {
        process.stderr.write('error: dream apply requires a job id\n');
        process.exit(1);
      }
      const autoApplyConfidence = args.flags['auto-apply-confidence']
        ? Number(args.flags['auto-apply-confidence'])
        : null;
      const result = applyDreamJob(db, key, jobId, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        autoApplyConfidence,
      });
      if (asJson) emitJson({ operation: 'dream_apply', result });
      else {
        process.stdout.write(`ok=${result.ok}\n`);
        if (result.ok) {
          process.stdout.write(`applied=${result.applied || 0}\n`);
          process.stdout.write(`stale=${result.stale || 0}\n`);
          process.stdout.write(`failed=${result.failed || 0}\n`);
        }
      }
      closeDb();
      return;
    }
    if (sub === 'discard') {
      const jobId = args.positional[1];
      if (!jobId) {
        process.stderr.write('error: dream discard requires a job id\n');
        process.exit(1);
      }
      const reason = args.flags.reason ? String(args.flags.reason) : 'cancelled';
      const result = discardDreamJob(db, key, jobId, { reason });
      if (asJson) emitJson({ operation: 'dream_discard', result });
      else process.stdout.write(`ok=${result.ok}\nstatus=${result.status || ''}\n`);
      closeDb();
      return;
    }
    process.stderr.write(`error: unknown dream subcommand: ${sub}\n`);
    process.exit(1);
  } catch (e) {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    throw e;
  }
}
