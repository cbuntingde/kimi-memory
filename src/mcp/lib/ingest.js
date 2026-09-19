// Ingest one wire.jsonl session into a project's conversation tables.
//
// Extracted from src/server.js (was the local `ingestOne` function
// inside makeServer) so conversations.js can call it without
// reaching back into the orchestrator. The behaviour is byte-
// identical to the prior inline version: same cursor state,
// same partial-failure semantics (persist the cursor so a retry
// resumes from the last successful byte, not byte 0), same response
// shape.
//
// External callers previously accessed this via the return value of
// `makeServer().ingestOne`. No source file currently uses that path
// (grep confirms), but the symbol remains importable from this
// module so a future caller can reach it without going through the
// orchestrator.

import { nowIso } from '../../util.js';
import { ensureProjectDir } from '../../project-key.js';
import {
  loadIngestState,
  saveIngestState,
  upsertConversation,
  recordConversationEvent,
  updateConversationProgress,
} from '../../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../../wire.js';

export async function ingestOne({ home, db, projectKey, cwd, sessionId, workDirKey, force }) {
  await ensureProjectDir(home, projectKey);
  const state = await loadIngestState(home, projectKey);
  if (!state.sessions) state.sessions = {};
  const sessionKey = sessionId;
  const prev = state.sessions[sessionKey] || {};
  let wdk = workDirKey || prev.work_dir_key || null;
  if (!wdk) {
    const idx = await readSessionIndex(home);
    const hit = idx.find(
      (e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId),
    );
    if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
  }
  const filePath = await locateSessionArchive(home, wdk, sessionId);
  if (!filePath) {
    return {
      ingested: 0,
      status: 'archive_not_found',
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: projectKey,
    };
  }
  upsertConversation(db, projectKey, sessionId, cwd);
  const startByte = force ? 0 : prev.byte_offset || 0;
  let lastEventAt = force ? null : prev.last_event_at || null;
  let finalOffset = startByte;
  let newEvents = 0;
  let lineNo = force ? 0 : prev.line_count || 0;
  const lineBase = lineNo;
  let walkerFailed = null;
  // Persist the cursor even on partial failure so a subsequent
  // ingest resumes from the last successfully-recorded byte instead
  // of restarting from byte 0 and re-trying the same failing tail.
  // (Audit finding B1-6.)
  try {
    for await (const ev of walkWire(filePath, startByte, lineBase)) {
      finalOffset = ev.nextByteOffset;
      lineNo = ev.lineNo;
      recordConversationEvent(db, projectKey, sessionId, ev.lineNo, ev.byteOffset, ev);
      newEvents += 1;
      if (ev.created_at) lastEventAt = ev.created_at;
    }
  } catch (e) {
    walkerFailed = e && (e.message || String(e));
  }
  updateConversationProgress(db, projectKey, sessionId, finalOffset, lineNo, lastEventAt);
  state.sessions[sessionKey] = {
    work_dir_key: wdk,
    byte_offset: finalOffset,
    line_count: lineNo,
    last_event_at: lastEventAt,
    last_import_at: nowIso(),
    last_error: walkerFailed,
  };
  await saveIngestState(home, projectKey, state);
  return {
    ingested: newEvents,
    archive: filePath,
    session_id: sessionId,
    work_dir_key: wdk,
    project_key: projectKey,
    status: walkerFailed ? 'partial' : 'ok',
    byte_offset: finalOffset,
    last_error: walkerFailed || undefined,
  };
}
