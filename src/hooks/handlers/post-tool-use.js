// PostToolUse handler. Mid-turn recall: when the agent invokes a tool,
// look up matching stored memories and emit a small set of
// [tool-recall] lines on stdout before the model continues.

import path from 'node:path';
import { ensureProjectDir, deriveProjectKey } from '../../project-key.js';
import {
  HOME,
  EVENT,
  payloadProjectRoot,
  safeOpenDb,
  logDiag,
  emitLines,
  isPlainObject,
} from './_helpers.js';
import { runToolRecall, formatToolRecallLines } from '../tool-recall.js';

// Field names Kimi has used for tool input on PostToolUse payloads.
// Same shape as PAYLOAD_CWD_KEYS etc., but for the tool-call envelope.
const TOOL_ARGS_KEYS = [
  'tool_input',
  'toolInput',
  'input',
  'args',
  'arguments',
  'command',
  'file_path',
  'path',
];

function payloadToolArgs(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of TOOL_ARGS_KEYS) {
    const v = payload[key];
    if (v == null) continue;
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'object') return v;
  }
  if (payload.tool_call && typeof payload.tool_call === 'object') {
    return payload.tool_call.input || payload.tool_call.args || null;
  }
  return null;
}

export async function handlePostToolUse(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  const toolArgs = payloadToolArgs(payload);
  if (toolArgs == null) return { ok: true, skipped: 'no_tool_args', lines: [] };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDb = safeOpenDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  const globalDb = safeOpenDb(path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite'));
  let result;
  try {
    result = await runToolRecall({
      projectDb,
      globalDb,
      projectKey: key,
      toolArgs,
    });
  } catch (e) {
    await logDiag('warn', 'tool_recall threw', { error: e && e.message });
    return { ok: true, skipped: 'tool_recall_threw', lines: [] };
  }
  const lines = formatToolRecallLines(result);
  if (lines.length > 0) emitLines(lines);
  return { ok: true, hits: result.hits.length, lines };
}
