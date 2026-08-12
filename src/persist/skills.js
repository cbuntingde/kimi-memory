// Skill triggers + invocation stats.
//
// Skills are memories with type='skill' that carry a structured
// trigger surface in metadata.trigger ({commands, paths, keywords}).
// The hook layer calls matchSkillTriggers on every UserPromptSubmit
// so a stored skill can surface as a one-line hint alongside the
// recall lines. Invocations are recorded in skill_invocations for
// stats / ranking.
import { nowIso, hashId, shortId } from '../util.js';
import { rowToMemory } from './memories.js';

/**
 * Score every active skill against an arbitrary (command?, file_path?,
 * ...arbitrary) tool-call args shape. Each skill carries a trigger
 * object with at most three arrays: `commands` (substring match on the
 * `command` field), `paths` (suffix/segment match on the `file_path`
 * field), and `keywords` (substring match on any other string value).
 *
 * Returns the top `limit` matches by score, descending. Empty trigger
 * objects produce no match.
 */
export function matchSkillTriggers(db, projectKey, args, { limit = 5 } = {}) {
  const cap = Math.max(1, Math.min(50, limit));
  const argCommand = typeof args.command === 'string' ? args.command : '';
  const argPath = typeof args.file_path === 'string' ? args.file_path : '';
  // Other arbitrary string values get keyword-scanned.
  const keywordHaystack = Object.entries(args || {})
    .filter(([k, v]) => typeof v === 'string' && k !== 'command' && k !== 'file_path')
    .map(([, v]) => v)
    .join(' ');
  const rows = db
    .prepare(
      `SELECT id, type, title, content, tags, metadata, provenance, confidence, status,
              priority, supersedes, superseded_by, created_at, updated_at,
              expires_at, embedding, embedding_model, last_embed_error,
              access_count, last_accessed_at, stability_days, last_rehearsed_at,
              visibility, shared_with, team_id, agent_id, user_id, session_id,
              task_id, tier, persona_id
         FROM memories
        WHERE project_key = ? AND type = 'skill' AND status = 'active'`,
    )
    .all(projectKey);
  const matches = [];
  for (const row of rows) {
    let meta;
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      meta = {};
    }
    const trig = meta.trigger || {};
    if (!trig || typeof trig !== 'object') continue;
    let score = 0;
    const cmdList = Array.isArray(trig.commands) ? trig.commands : [];
    const pathList = Array.isArray(trig.paths) ? trig.paths : [];
    const kwList = Array.isArray(trig.keywords) ? trig.keywords : [];
    if (cmdList.length > 0 && argCommand) {
      for (const c of cmdList) {
        if (typeof c !== 'string' || c.length === 0) continue;
        if (argCommand.includes(c)) {
          score += 2.0;
          break;
        }
      }
    }
    if (pathList.length > 0 && argPath) {
      for (const p of pathList) {
        if (typeof p !== 'string' || p.length === 0) continue;
        // Path match: suffix match OR exact segment match (last path
        // component equal). Tolerant of forward/back slashes.
        const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
        if (
          norm(argPath).endsWith('/' + norm(p)) ||
          norm(argPath).endsWith(norm(p)) ||
          norm(argPath) === norm(p)
        ) {
          score += 1.5;
          break;
        }
      }
    }
    if (kwList.length > 0 && keywordHaystack) {
      for (const k of kwList) {
        if (typeof k !== 'string' || k.length === 0) continue;
        if (keywordHaystack.toLowerCase().includes(k.toLowerCase())) {
          score += 1.0;
          break;
        }
      }
    }
    if (score > 0) {
      matches.push({ row, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, cap);
  return top.map((m) => ({
    ...rowToMemory(m.row),
    trigger_score: m.score,
  }));
}

/**
 * Record a single skill invocation. Inserts a row into
 * skill_invocations with success/failure flag and tool name.
 *
 * The scaffold test calls this with `{success: 0|1, toolName: 'x'}`;
 * durationMs is optional and may be added later.
 */
export function recordSkillInvocation(
  db,
  projectKey,
  skillId,
  { success, toolName, durationMs = null } = {},
) {
  const ok = success === 1 || success === true ? 1 : 0;
  // Three calls in the same millisecond would otherwise collide on
  // PRIMARY KEY; mix in nanoseconds + a per-call counter so the id
  // is unique even under tight loops.
  const stamp = `${nowIso()}:${Date.now() % 1e9}:${Math.floor(Math.random() * 1e9)}`;
  const id = shortId(hashId('skinv', projectKey, skillId, stamp), 16);
  db.prepare(
    `INSERT INTO skill_invocations (id, skill_id, project_key, tool_name, success, duration_ms, invoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, skillId, projectKey, toolName || null, ok, durationMs, nowIso());
  return { id, skill_id: skillId, success: ok };
}

/**
 * Aggregate skill_invocations for a skill: count and success rate.
 * Returns { invoke_count, success_rate } where success_rate is a float
 * in [0, 1] (or 0 when invoke_count is 0).
 */
export function updateSkillInvocationStats(db, projectKey, skillId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(success), 0) AS successes
       FROM skill_invocations
       WHERE project_key = ? AND skill_id = ?`,
    )
    .get(projectKey, skillId);
  const total = row ? row.total : 0;
  const successes = row ? row.successes : 0;
  const success_rate = total > 0 ? successes / total : 0;
  return { invoke_count: total, success_rate };
}

/**
 * List every active skill in the project. Excludes superseded rows
 * and any row whose processing_status === 'pending' (the scaffold
 * test asserts that pending rows are filtered).
 */
export function listSkillMemories(db, projectKey) {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE project_key = ? AND type = 'skill' AND status = 'active'`,
    )
    .all(projectKey);
  const out = [];
  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.metadata || '{}');
    } catch {
      meta = {};
    }
    if (meta.processing_status === 'pending') continue;
    out.push(rowToMemory(r));
  }
  return out;
}
