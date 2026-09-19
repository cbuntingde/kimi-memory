// Dream (staged consolidation) MCP handlers (9 tools).
//
//   dream_list_jobs           — list queued/running/ready/applied/failed jobs
//   dream_get_job             — fetch a job + its proposals
//   dream_list_proposals      — filter proposals within a job
//   dream_get_proposal        — fetch one proposal
//   dream_status              — counts + last applied timestamps
//   dream_enqueue             — schedule a new consolidation job
//   dream_generate_proposals  — fill a job with proposals (calls saveMemory/link/merge)
//   dream_apply_job           — apply a job's proposals to the DB
//   dream_discard_job         — cancel a job
//
// All 9 are project-scoped reads or writes (no scope arg on the wire).

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateLimit, validateId } from '../../validation.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  discardDreamJob,
  listJobs as listDreamJobs,
  listProposals as listDreamProposals,
  readJob as readDreamJob,
  readProposal as readDreamProposal,
  buildDreamStatus,
} from '../../dream.js';
import { saveMemory } from '../../persist/memories.js';
import { linkMemory } from '../../persist/edges.js';
import { mergeMemory } from '../../persist/memories.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- dream_list_jobs ----
  registerTool(
    server,
    D.dream_list_jobs,
    async (args, ctx) => {
      const lim = validateLimit(args.limit, 1, 100, 20);
      if (!lim.ok) throw toolError(lim.error);
      const items = listDreamJobs(ctx.db, ctx.projectKey, {
        status: args.status || null,
        limit: lim.value,
      });
      return {
        operation: 'dream_list_jobs',
        status: args.status || null,
        items,
        count: items.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_get_job ----
  registerTool(
    server,
    D.dream_get_job,
    async (args, ctx) => {
      const jobId = validateId(args.job_id);
      if (!jobId.ok) throw toolError(jobId.error);
      const job = readDreamJob(ctx.db, ctx.projectKey, jobId.value);
      if (!job) throw toolError(`dream job not found: ${jobId.value}`);
      const proposals = listDreamProposals(ctx.db, ctx.projectKey, jobId.value);
      return {
        operation: 'dream_get_job',
        job,
        proposals,
        proposals_count: proposals.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_list_proposals ----
  registerTool(
    server,
    D.dream_list_proposals,
    async (args, ctx) => {
      const jobId = validateId(args.job_id);
      if (!jobId.ok) throw toolError(jobId.error);
      const items = listDreamProposals(ctx.db, ctx.projectKey, jobId.value, {
        status: args.status || null,
      });
      return {
        operation: 'dream_list_proposals',
        job_id: jobId.value,
        status: args.status || null,
        items,
        count: items.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_get_proposal ----
  registerTool(
    server,
    D.dream_get_proposal,
    async (args, ctx) => {
      const propId = validateId(args.proposal_id);
      if (!propId.ok) throw toolError(propId.error);
      const proposal = readDreamProposal(ctx.db, ctx.projectKey, propId.value);
      if (!proposal) throw toolError(`dream proposal not found: ${propId.value}`);
      return {
        operation: 'dream_get_proposal',
        proposal,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_status ----
  registerTool(
    server,
    D.dream_status,
    async (args, ctx) => {
      const status = buildDreamStatus(ctx.db, ctx.projectKey);
      return {
        operation: 'dream_status',
        status,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_enqueue ----
  registerTool(
    server,
    D.dream_enqueue,
    async (args, ctx) => {
      const result = enqueueDreamJob(ctx.db, ctx.projectKey, {
        triggered_by: 'mcp_tool',
      });
      return {
        operation: 'dream_enqueue',
        result,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_generate_proposals ----
  registerTool(
    server,
    D.dream_generate_proposals,
    async (args, ctx) => {
      const jobId = validateId(args.job_id);
      if (!jobId.ok) throw toolError(jobId.error);
      const result = await generateProposalsForJob(ctx.db, ctx.projectKey, jobId.value, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      return {
        operation: 'dream_generate_proposals',
        job_id: jobId.value,
        result,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_apply_job ----
  registerTool(
    server,
    D.dream_apply_job,
    async (args, ctx) => {
      const jobId = validateId(args.job_id);
      if (!jobId.ok) throw toolError(jobId.error);
      const result = applyDreamJob(ctx.db, ctx.projectKey, jobId.value, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        autoApplyConfidence:
          typeof args.auto_apply_confidence === 'number' ? args.auto_apply_confidence : null,
      });
      return {
        operation: 'dream_apply_job',
        job_id: jobId.value,
        result,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- dream_discard_job ----
  registerTool(
    server,
    D.dream_discard_job,
    async (args, ctx) => {
      const jobId = validateId(args.job_id);
      if (!jobId.ok) throw toolError(jobId.error);
      const result = discardDreamJob(ctx.db, ctx.projectKey, jobId.value, {
        reason: args.reason || 'cancelled',
      });
      return {
        operation: 'dream_discard_job',
        job_id: jobId.value,
        result,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );
}
