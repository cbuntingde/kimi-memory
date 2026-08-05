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
import { withLlmRetry } from './retry.js';
import { logAutoExtractError } from './diagnostics.js';
import { parseToml } from './toml.js';

const MAX_CANDIDATES_PER_CALL = 3;
const MAX_INPUT_CHARS = 12000; // ~3k tokens of conversation context
const LLM_TIMEOUT_MS = 4000; // hard cap on the chat call

// Best-effort secret detection. The README and SKILL.md claim that
// auto-extraction skips "anything that looks like a secret"; this
// regex set is the implementation of that claim. The patterns cover
// the well-known key shapes (OpenAI, Anthropic, GitHub, AWS, JWT,
// PEM) plus generic `key/token/secret/password` assignments. False
// positives are accepted: dropping a candidate that mentions a
// generic "api_key" is far cheaper than persisting a real one.
const SECRET_PATTERNS = [
  // Provider-specific key shapes.
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/, // Anthropic
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/, // GitLab PAT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*?PRIVATE KEY-----/, // PEM
  /-----BEGIN [A-Z ]*?OPENSSH PRIVATE KEY-----/,
  // Generic key/token/secret/password assignments — must follow a
  // word boundary and have a non-trivial value (≥8 chars).
  /(^|[\s,;])(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9_/+=-]{8,})/i,
  // Bearer / Authorization headers.
  /Authorization\s*:\s*Bearer\s+[A-Za-z0-9_.-]{20,}/i,
];

// Returns true if the given text appears to contain a secret. Used
// to filter auto-extracted candidate memories so a misbehaving model
// reply does not persist a credential into the durable store.
export function looksLikeSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  for (const p of SECRET_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}
const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction module. Read the conversation and any project metadata summary provided, and decide whether it contains any durable facts worth remembering for the user's future self.

A "durable fact" is a preference, decision, convention, or stable context that would still be useful hours or days later. Skip transient debugging, in-flight tasks, and one-off questions.

In addition to conversation facts, extract project build/stack details when present:
- build command(s)
- test command(s)
- dependency update policy (e.g., "check for latest unless pinned or specified")
- short stack summary (language, framework, tooling)

Respond with a JSON array. Each entry: { "type": "semantic"|"episodic"|"procedural", "title": "<=80 chars>", "content": "<=500 chars", "tags": ["<short tag>", ...] }.
Return [] if nothing qualifies. No prose, no markdown fences — JSON only.`;

// Project metadata detector: reads well-known manifests under the
// project root and returns a compact summary for build/stack extraction.
// No network, no new dependencies, fail-open.
async function detectProjectMetadata(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const out = {
    stack: [],
    buildCommand: null,
    testCommand: null,
    deps: [],
    pinnedDeps: [],
    updatePolicy: null,
  };
  try {
    const pkgPath = path.join(cwd, 'package.json');
    const pkgText = await fs.readFile(pkgPath, 'utf8');
    const pkg = safeJsonParse(pkgText).ok ? safeJsonParse(pkgText).value : null;
    if (!pkg || typeof pkg !== 'object') return null;
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    out.buildCommand = asString(scripts.build) || null;
    out.testCommand = asString(scripts.test) || asString(scripts['test:watch']) || null;
    const packageManager = asString(pkg.packageManager) || null;
    if (packageManager) out.stack.push(packageManager);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    const depNames = Object.keys(allDeps);
    out.deps = depNames.slice(0, 20);
    out.pinnedDeps = depNames.filter((d) => /^[\^~]/.test(allDeps[d] || ''));
    if (pkg.workspaces && Array.isArray(pkg.workspaces) && pkg.workspaces.length) {
      out.stack.push('workspaces');
    }
    const hasTypeScript = depNames.some(
      (d) => d === 'typescript' || d.startsWith('@types/'),
    );
    if (hasTypeScript) out.stack.push('typescript');
  } catch {
    // package.json missing or unparseable — ignore
  }

  try {
    const tsPath = path.join(cwd, 'tsconfig.json');
    const tsText = await fs.readFile(tsPath, 'utf8');
    const ts = safeJsonParse(tsText).ok ? safeJsonParse(tsText).value : null;
    if (ts && typeof ts === 'object' && ts.compilerOptions && typeof ts.compilerOptions === 'object') {
      const opts = ts.compilerOptions;
      const bits = [];
      if (opts.target) bits.push(`target=${opts.target}`);
      if (opts.module) bits.push(`module=${opts.module}`);
      if (opts.jsx) bits.push(`jsx=${opts.jsx}`);
      if (opts.baseUrl) bits.push(`baseUrl=${opts.baseUrl}`);
      if (opts.paths) bits.push('paths');
      if (opts.strict) bits.push('strict');
      if (bits.length) out.stack.push('tsconfig(' + bits.join(', ') + ')');
    }
  } catch {
    // tsconfig missing or unparseable
  }

  if (out.stack.length === 0 && !out.buildCommand && !out.testCommand) return null;
  if (!out.updatePolicy) out.updatePolicy = 'Check for latest unless pinned or specified in manifest';
  return out;
}

export { detectProjectMetadata, buildExtractionPrompt };

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
function buildExtractionPrompt(transcript, existingTitles, projectMeta) {
  const trimmed = String(transcript || '').slice(0, MAX_INPUT_CHARS);
  const titlesLine =
    existingTitles && existingTitles.length
      ? `\nFor dedup, here are titles already in this project's memory (avoid repeating these):\n- ${existingTitles.slice(0, 50).join('\n- ')}\n`
      : '';
  const metaLine = projectMeta
    ? `\nProject metadata (from manifest files):\n${JSON.stringify(projectMeta, null, 2)}\n`
    : '';
  return {
    system: EXTRACT_SYSTEM_PROMPT,
    user: `${titlesLine}${metaLine}Conversation transcript:\n"""\n${trimmed}\n"""\n\nJSON array of candidate memories:`,
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
//   secrets_dropped: 0,
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
  resolveLlmTargetImpl = resolveLlmTarget,
  now = () => Date.now(),
  // Env-driven opt-outs. Tests can override the default.
  isDisabled = () => process.env.KIMI_MEMORY_AUTO_EXTRACT === 'off',
  isConfigDisabled = (cfg) =>
    !!(cfg && cfg['kimi-memory'] && cfg['kimi-memory'].disable_auto_extract),
  // Injection seam for tests: replace the secret detector.
  secretDetector = looksLikeSecret,
}) {
  const result = {
    skipped: null,
    extracted: 0,
    saved: 0,
    duplicates: 0,
    secrets_dropped: 0,
    error: null,
  };
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
  const target = await resolveLlmTargetImpl(homeDir);
  if (target.error) {
    result.skipped = target.error;
    return result;
  }

  const projectMeta = await detectProjectMetadata(cwd);
  const prompt = buildExtractionPrompt(transcript, existingTitles || [], projectMeta);
  
  let reply;
  try {
    // Retry with exponential backoff for transient LLM failures.
    reply = await withLlmRetry(
      () => callLlm({ ...target, system: prompt.system, user: prompt.user }),
      { projectKey, maxAttempts: 3, baseDelayMs: 1000 }
    );
  } catch (error) {
    // LLM call failed after retries; log and continue with no extraction.
    await logAutoExtractError(
      projectKey,
      'llm_failed_after_retries',
      error,
      { max_attempts: 3, error_code: error?.code }
    ).catch(() => {});
    result.skipped = 'llm_failed_after_retries';
    result.error = error && error.message ? error.message : String(error);
    return result;
  }
  
  if (!reply) {
    result.skipped = 'llm_no_reply';
    return result;
  }
  const candidates = parseExtractionResponse(reply);
  result.extracted = candidates.length;

  const { kept, duplicates } = await dedupeCandidates({
    db,
    projectKey,
    candidates,
    searchMemories,
  });
  result.duplicates = duplicates.length;

  const deterministic = [];
  if (projectMeta) {
    const stack = projectMeta.stack && projectMeta.stack.length ? projectMeta.stack.join(', ') : 'unknown';
    deterministic.push({
      type: 'semantic',
      title: 'Project build/stack details',
      content: `Stack: ${stack}. Build: ${projectMeta.buildCommand || 'n/a'}. Test: ${projectMeta.testCommand || 'n/a'}. Update policy: ${projectMeta.updatePolicy || 'n/a'}.`,
      tags: ['build', 'stack', 'project'],
      supersede: true,
    });
    if (projectMeta.updatePolicy) {
      deterministic.push({
        type: 'procedural',
        title: 'Dependency update policy',
        content: projectMeta.updatePolicy,
        tags: ['dependencies', 'updates', 'project'],
        supersede: true,
      });
    }
  }

  const allCandidates = [...kept, ...deterministic];
  if (allCandidates.length === 0) return result;
  for (const cand of allCandidates) {
    // Secret scrub: the model may echo back a credential the user
    // typed in the transcript, or it may have invented a key in its
    // own reply. Either way, a candidate that matches a known secret
    // shape is dropped on the floor and counted in the result so the
    // operator can see what was suppressed.
    if (secretDetector(cand.content) || secretDetector(cand.title)) {
      result.secrets_dropped += 1;
      continue;
    }
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
