// Auto-extraction hook for kimi-memory.
//
// Reads the agent's $KIMI_CODE_HOME/config.toml to discover the active
// model + provider, sends the most recent conversation exchange to that
// model with a small extraction prompt, and saves any returned candidate
// memories through the existing saveMemory path (low confidence, marked
// with provenance.source='auto_extract' so the user can filter them).
//
// Fail-open by design: every step that touches the network, the parser,
// or the model is wrapped so an outage never blocks the agent lifecycle.
// The hook reports structured counts ({"skipped": "no_provider", ...})
// instead of throwing.
//
// Disabled by default if the env var KIMI_MEMORY_AUTO_EXTRACT=off is
// set, or if the parsed config carries
// `kimi-memory.disable_auto_extract = true`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nowIso, safeJsonParse, asString } from './util.js';

const MAX_CANDIDATES_PER_CALL = 3;
const MAX_INPUT_CHARS = 12000; // ~3k tokens of conversation context
const LLM_TIMEOUT_MS = 4000; // hard cap on the chat call
const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction module. Read the conversation and decide whether it contains any durable facts worth remembering for the user's future self.

A "durable fact" is a preference, decision, convention, or stable context that would still be useful hours or days later. Skip transient debugging, in-flight tasks, and one-off questions.

Respond with a JSON array. Each entry: { "type": "semantic"|"episodic"|"procedural", "title": "<=80 chars>", "content": "<=500 chars", "tags": ["<short tag>", ...] }.
Return [] if nothing qualifies. No prose, no markdown fences — JSON only.`;

// ----- minimal TOML parser (covers the kimi-code config.toml subset) -----
// Handles: comments, bare/quote keys, [section] headers (with quoted
// segments that may contain dots, e.g. [models."minimax/MiniMax-M3"]),
// basic scalars (string, int, float, bool), string arrays. Sufficient
// for the config.toml we ship; not a full TOML implementation.
function parseToml(text) {
  const out = {};
  let cur = out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#[^"]*$/, '').trim(); // strip non-string comments
    if (!line) continue;
    if (line.startsWith('[')) {
      const sec = line.replace(/^\[|\]$/g, '').trim();
      const parts = splitTomlPath(sec);
      let node = out;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] || {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = node[parts[parts.length - 1]] || {};
      cur = node[parts[parts.length - 1]];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = unquoteKey(line.slice(0, eq).trim());
    const v = parseTomlValue(line.slice(eq + 1).trim());
    cur[k] = v;
  }
  return out;
}
// Split a section header like `models."minimax/MiniMax-M2.7"` into
// ['models', 'minimax/MiniMax-M2.7'] — respecting quoted segments so a
// `.` inside a quoted name is part of the segment, not a path split.
function splitTomlPath(s) {
  const out = [];
  let buf = '';
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      buf += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      buf += c;
      continue;
    }
    if (c === '.') {
      out.push(unquoteKey(buf));
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(unquoteKey(buf));
  return out.filter((p) => p.length > 0);
}
function unquoteKey(k) {
  k = k.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    return k.slice(1, -1);
  }
  return k;
}
function parseTomlValue(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const q = raw[0];
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === q) return out;
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : n === '"' ? '"' : n;
        i++;
      } else out += c;
    }
    return out;
  }
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, raw.lastIndexOf(']'));
    const items = [];
    let depth = 0,
      buf = '';
    for (const c of inner) {
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === ',' && depth === 0) {
        items.push(buf.trim());
        buf = '';
        continue;
      }
      buf += c;
    }
    if (buf.trim()) items.push(buf.trim());
    return items.map(parseTomlValue);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

// Read $KIMI_CODE_HOME/config.toml. Returns {} on missing/unreadable;
// never throws — auto-extraction must not break the hook. Cached per
// homeDir for 30s; tests rely on the per-homeDir key to avoid bleed.
const _cachedConfigByHome = new Map();
const CONFIG_TTL_MS = 30_000;

export async function readConfig(homeDir) {
  const now = Date.now();
  const hit = _cachedConfigByHome.get(homeDir);
  if (hit && now - hit.at < CONFIG_TTL_MS) return hit.value;
  const configPath = path.join(homeDir, 'config.toml');
  let text = '';
  let value = {};
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch {
    _cachedConfigByHome.set(homeDir, { at: now, value });
    return value;
  }
  try {
    value = parseToml(text);
  } catch (e) {
    try {
      process.stderr.write(`[kimi-memory] config.toml parse failed: ${e && e.message}\n`);
    } catch {
      /* ignore */
    }
    value = {};
  }
  _cachedConfigByHome.set(homeDir, { at: now, value });
  return value;
}

// Resolve the chat target the agent would use. Returns { provider, model,
// apiKey, baseUrl, type } or { error: 'reason' } so the caller can skip
// cleanly without a try/catch.
export async function resolveLlmTarget(homeDir) {
  const cfg = await readConfig(homeDir);
  if (!cfg || typeof cfg !== 'object') return { error: 'no_config' };
  const defaultModel = asString(cfg.default_model);
  if (!defaultModel) return { error: 'no_default_model' };
  const modelBlock = (cfg.models && cfg.models[defaultModel]) || null;
  if (!modelBlock) return { error: `model_not_found:${defaultModel}` };
  const providerName = asString(modelBlock.provider);
  const providerBlock = (cfg.providers && cfg.providers[providerName]) || null;
  if (!providerBlock) return { error: `provider_not_found:${providerName}` };
  return {
    provider: providerName,
    model: asString(modelBlock.model) || defaultModel,
    apiKey: asString(providerBlock.api_key),
    baseUrl: asString(providerBlock.base_url),
    type: asString(providerBlock.type) || 'openai',
  };
}

// Build the extraction prompt. existingTitles is a list of titles
// already in the project's active memories; listing them nudges the
// model away from duplicates the dedup pass would also catch.
function buildExtractionPrompt(transcript, existingTitles) {
  const trimmed = String(transcript || '').slice(0, MAX_INPUT_CHARS);
  const titlesLine =
    existingTitles && existingTitles.length
      ? `\nFor dedup, here are titles already in this project's memory (avoid repeating these):\n- ${existingTitles.slice(0, 50).join('\n- ')}\n`
      : '';
  return {
    system: EXTRACT_SYSTEM_PROMPT,
    user: `Existing memory titles:${titlesLine}\nConversation transcript:\n"""\n${trimmed}\n"""\n\nJSON array of candidate memories:`,
  };
}

// Parse the model's reply. Accepts either a JSON array or an object
// wrapped under `candidates`/`memories`/`items`. Falls back to [] on
// parse failure; never throws.
export function parseExtractionResponse(text) {
  if (!text || typeof text !== 'string') return [];
  let s = text.trim();
  // Strip markdown fences if the model added them despite the prompt.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const parsed = safeJsonParse(s);
  if (!parsed.ok) return [];
  let arr = parsed.value;
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === 'object') {
      for (const k of ['candidates', 'memories', 'items', 'results']) {
        if (Array.isArray(arr[k])) {
          arr = arr[k];
          break;
        }
      }
    }
    if (!Array.isArray(arr)) return [];
  }
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const type = asString(raw.type);
    if (!['semantic', 'episodic', 'procedural'].includes(type)) continue;
    const title = asString(raw.title).slice(0, 500);
    const content = asString(raw.content).slice(0, 4000);
    if (!content) continue;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 64).slice(0, 16)
      : [];
    out.push({ type, title, content, tags });
    if (out.length >= MAX_CANDIDATES_PER_CALL) break;
  }
  return out;
}

// Call a chat-completion endpoint. Supports both OpenAI-compatible and
// Anthropic-compatible providers (the two types declared in the config).
// Returns the assistant text on success, null on any failure (so the
// caller can skip silently).
export async function callChat({ apiKey, baseUrl, type, model, system, user, signal }) {
  if (!apiKey || !baseUrl) return null;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());
  try {
    const url = baseUrl.replace(/\/+$/, '');
    if (type === 'anthropic') {
      const res = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const parts = body && body.content;
      if (!Array.isArray(parts)) return null;
      return parts
        .map((p) => (p && p.text) || '')
        .join('')
        .trim();
    }
    // OpenAI-compatible (covers openai, nvidia, poolside, stepfun, …).
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const choice = body && body.choices && body.choices[0];
    const msg = choice && choice.message;
    return msg && typeof msg.content === 'string' ? msg.content.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Deduplicate a candidate list against existing memories.
//
// Two-stage check, ordered from cheap → accurate:
//   1. Title-token overlap (in-process, <1ms). If the candidate's title
//      shares ≥ MIN_TITLE_OVERLAP tokens with an existing memory's
//      title, declare it a duplicate. Catches the obvious "uses tabs"
//      vs "prefers tabs" case regardless of FTS5's prefix-AND quirks.
//   2. Hybrid recall (#1) — only consulted if the cheap check passes.
//      In the vector path, cosine ≥ `threshold` is a duplicate. In the
//      FTS-only path, the first hit's title is compared with the same
//      overlap rule.
//
// `searchMemories` is the real `searchMemories` from persist.js. When
// embeddings are off, the second stage will rarely fire because the
// cheap overlap check has already handled the common cases.
//
// inputs:
//   candidates: [{ type, title, content, tags }, ...]
// returns:
//   { kept: [...], duplicates: [{candidate, existing}] }
const MIN_TITLE_OVERLAP = 2; // shared tokens (≥2) → duplicate
const MIN_TITLE_OVERLAP_RATIO = 0.5; // or ≥50% of candidate tokens shared

function tokenizeTitle(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32);
}

export async function dedupeCandidates({
  db,
  projectKey,
  candidates,
  searchMemories,
  threshold = 0.85,
}) {
  const kept = [];
  const duplicates = [];
  // Pull all active memory titles once. Cheap enough for the working
  // set and lets the cheap overlap check run in O(candidates * titles).
  const existing = db
    .prepare("SELECT id, title, content FROM memories WHERE project_key = ? AND status = 'active'")
    .all(projectKey)
    .map((r) => ({
      id: r.id,
      title: r.title || '',
      titleTokens: tokenizeTitle(r.title || ''),
      content: r.content || '',
    }));

  for (const cand of candidates) {
    const candTitleTokens = tokenizeTitle(cand.title || '');
    // Stage 1: token overlap against every existing memory's title.
    let dup = null;
    if (candTitleTokens.length > 0) {
      let bestOverlap = 0;
      for (const e of existing) {
        if (e.titleTokens.length === 0) continue;
        const eSet = new Set(e.titleTokens);
        let shared = 0;
        for (const t of candTitleTokens) if (eSet.has(t)) shared++;
        if (shared > bestOverlap) bestOverlap = shared;
        const ratio = shared / candTitleTokens.length;
        if (shared >= MIN_TITLE_OVERLAP || ratio >= MIN_TITLE_OVERLAP_RATIO) {
          dup = { id: e.id, title: e.title, content: e.content };
          break;
        }
      }
    }
    if (dup) {
      duplicates.push({ candidate: cand, existing: dup });
      continue;
    }

    // Stage 2: ask the hybrid recall. Only consulted if stage 1 didn't
    // match (rare) — so the LLM call cost stays negligible.
    let hits = [];
    try {
      hits = await searchMemories(db, projectKey, (cand.title || cand.content || '').trim(), {
        limit: 3,
      });
    } catch {
      hits = [];
    }
    const top = hits[0];
    if (top && top.similarity != null && top.similarity >= threshold) {
      duplicates.push({ candidate: cand, existing: top });
      continue;
    }
    kept.push(cand);
  }
  return { kept, duplicates };
}

// Top-level orchestration. Caller passes in the persist-layer
// functions so this module stays free of node:sqlite imports (and is
// trivially testable).
//
// result = {
//   skipped: 'reason' | null,
//   extracted: 0,
//   saved: 0,
//   duplicates: 0,
//   error: string | null,
// }
export async function runAutoExtract({
  homeDir,
  cwd,
  projectKey,
  db,
  transcript,
  existingTitles,
  saveMemory,
  searchMemories,
  // Injection seam for tests + future override (e.g. KIMI_MEMORY_AUTO_EXTRACT_LLM).
  callLlm = callChat,
  now = () => Date.now(),
  // Env-driven opt-outs. Tests can override the default.
  isDisabled = () => process.env.KIMI_MEMORY_AUTO_EXTRACT === 'off',
  isConfigDisabled = (cfg) =>
    !!(cfg && cfg['kimi-memory'] && cfg['kimi-memory'].disable_auto_extract),
}) {
  const result = { skipped: null, extracted: 0, saved: 0, duplicates: 0, error: null };
  if (isDisabled()) {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (!transcript || !String(transcript).trim()) {
    result.skipped = 'no_transcript';
    return result;
  }
  if (!saveMemory || !searchMemories) {
    result.skipped = 'no_persist';
    return result;
  }
  const cfg = await readConfig(homeDir);
  if (isConfigDisabled(cfg)) {
    result.skipped = 'config_opt_out';
    return result;
  }
  const target = await resolveLlmTarget(homeDir);
  if (target.error) {
    result.skipped = target.error;
    return result;
  }

  const prompt = buildExtractionPrompt(transcript, existingTitles || []);
  const reply = await callLlm({ ...target, system: prompt.system, user: prompt.user });
  if (!reply) {
    result.skipped = 'llm_no_reply';
    return result;
  }
  const candidates = parseExtractionResponse(reply);
  result.extracted = candidates.length;
  if (candidates.length === 0) return result;

  const { kept, duplicates } = await dedupeCandidates({
    db,
    projectKey,
    candidates,
    searchMemories,
  });
  result.duplicates = duplicates.length;

  for (const cand of kept) {
    try {
      saveMemory(db, projectKey, {
        type: cand.type,
        title: cand.title,
        content: cand.content,
        tags: cand.tags,
        confidence: 0.6, // lower than the default 0.8 to flag uncertainty
        priority: -1, // below user-saved rows in the default list order
        provenance: {
          source: 'auto_extract',
          model: target.model,
          provider: target.provider,
          cwd: cwd || null,
          recorded_at: nowIso(),
        },
      });
      result.saved += 1;
    } catch (e) {
      // Never block: a single failed save is logged via result.error and
      // the next candidate proceeds.
      result.error = e && e.message ? e.message : String(e);
    }
  }
  return result;
}
