import path from 'node:path';

import { deriveProjectKey } from '../../project-key.js';
import { openDb } from '../../persist/connection.js';
import { saveMemory } from '../../persist/memories.js';
import {
  HOME,
  payloadProjectRoot,
  payloadSessionId,
  logDiag,
  emitLines,
  truncate,
  isPlainObject,
} from './_helpers.js';

const MAX_ERROR_LENGTH = 500;
const MAX_INPUT_LENGTH = 200;
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

function readToolName(payload) {
  return typeof payload?.toolName === 'string' && payload.toolName.length > 0
    ? payload.toolName
    : null;
}

function readErrorMessage(payload) {
  return typeof payload?.error?.message === 'string' && payload.error.message.length > 0
    ? payload.error.message
    : null;
}

function buildTitle(toolName) {
  return `Tool failure: ${toolName}`;
}

function buildContent(toolName, errorMessage, toolInput) {
  const lines = [`Tool failed: ${toolName}`, `Error: ${truncate(errorMessage, MAX_ERROR_LENGTH)}`];
  if (toolInput !== undefined && toolInput !== null) {
    lines.push(`Input: ${truncate(JSON.stringify(toolInput), MAX_INPUT_LENGTH)}`);
  }
  lines.push('Reminder: re-read the tool schema before retrying; do not resend the same payload.');
  return lines.join('\n');
}

function findRecentDuplicate(db, projectKey, title, nowMs) {
  const cutoff = new Date(nowMs - DEDUP_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT id FROM memories
       WHERE project_key = ? AND type = 'procedural' AND title = ?
         AND status = 'active' AND updated_at >= ?
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
    )
    .get(projectKey, title, cutoff);
  return row?.id ?? null;
}

function validatePayload(payload) {
  if (!isPlainObject(payload)) return 'payload not an object';
  const toolName = readToolName(payload);
  const errorMessage = readErrorMessage(payload);
  if (toolName === null) return 'missing toolName';
  if (errorMessage === null) return 'missing error.message';
  return null;
}

export async function handlePostToolUseFailure(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no_project_cwd' };

  const validationError = validatePayload(payload);
  if (validationError !== null) {
    return { ok: false, reason: 'invalid_payload', detail: validationError };
  }

  const toolName = readToolName(payload);
  const errorMessage = readErrorMessage(payload);
  const toolInput = isPlainObject(payload.toolInput) ? payload.toolInput : null;
  const sessionId = payloadSessionId(payload);
  const toolCallId =
    typeof payload.toolCallId === 'string' && payload.toolCallId.length > 0
      ? payload.toolCallId
      : typeof payload.tool_call_id === 'string' && payload.tool_call_id.length > 0
        ? payload.tool_call_id
        : null;

  const projectKey = deriveProjectKey(cwd);
  const db = openDb(path.join(HOME, 'kimi-memory', projectKey, 'memory.sqlite'));

  const title = buildTitle(toolName);
  const nowMs = Date.now();

  try {
    const existingId = findRecentDuplicate(db, projectKey, title, nowMs);
    if (existingId !== null) {
      emitLines([`[tool-failure] deduped ${existingId} ${title}`]);
      return { ok: true, skipped: 'duplicate', id: existingId };
    }

    const memory = saveMemory(db, projectKey, {
      type: 'procedural',
      title,
      content: buildContent(toolName, errorMessage, toolInput),
      tags: ['tool-failure', 'self-correction'],
      confidence: 0.7,
      tier: 'L0',
      session_id: sessionId,
      agent_id: toolName,
      provenance: {
        source: 'hook:PostToolUseFailure',
        cwd,
        session_id: sessionId,
        tool_name: toolName,
        tool_call_id: toolCallId,
      },
    });
    emitLines([`[tool-failure] recorded ${memory.id} ${title}`]);
    return { ok: true, id: memory.id };
  } catch (error) {
    await logDiag('warn', 'post_tool_use_failure insert failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: 'insert_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
