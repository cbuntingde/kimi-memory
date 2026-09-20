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
import { isIP } from 'node:net';
import { nowIso, safeJsonParse, asString } from './util.js';
import { withLlmRetry } from './retry.js';
import { logAutoExtractError } from './diagnostics.js';
import { parseToml } from './toml.js';
import { looksLikeSecret, redactSecrets } from './secrets.js';

const MAX_CANDIDATES_PER_CALL = 6; // bumped from 3 to make room for durable + context_snapshot
const MAX_INPUT_CHARS = 12000; // ~3k tokens of conversation context
const LLM_TIMEOUT_MS = 4000; // hard cap on the chat call

// Secret detection + redaction live in the leaf module `secrets.js` so
// the storage layer's write gate can use them without importing this
// file (and through it the embedding model and the LLM client).
// Re-exported here because the extractor and every caller has always
// read them from this path.
export { looksLikeSecret, redactSecrets };

const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction module for an automated coding agent memory system. Read the conversation and any project metadata summary provided and emit a JSON array of candidate memories.

Every candidate must be one of these types:

* "semantic" — stable convention, decision, preference, or convention about the project (e.g. "uses tabs for indent", "commit policy: --squash, keep remote branch"). Durability: weeks+.
* "episodic" — a concrete event that happened (e.g. "shipped PR #N", "fixed the lint-disable justification gap"). Durability: months for postmortems; decays otherwise.
* "procedural" — how to do something repeatable (e.g. "run npm run check before commit", "verification commands: go mod tidy && go build ./…"). Durability: stable until the workflow changes.
* "context_snapshot" — project state, current focus, plans, or "I am about to look at X, checking Y" narration that the user will want recalled next session but should NOT crowd out durable facts. Use this when:
    * the user stated what they are investigating / planning to do ("let me look at the current state of the repo to understand context, and check for prior sea work")
    * an in-progress task has a clear goal ("implement audit-lint-disable-justification", "ship code-discipline v2")
    * the assistant declared a focus area ("focus: v2 integration tests next", "investigating post-write review flow")
    * the conversation captures a snapshot of the project's state at a point in time ("C:\\Chris-Dev\\kimi-code is at commit b38a176, audit-log entry F2 landed")

Auto-extraction is automatic and fully hands-off. The user does NOT want to manually call a save tool to preserve state — every piece of state worth recalling on a future turn must be captured here, including narration-style "I'm about to investigate X" lines, framed as a snapshot. Tag every context_snapshot with tags including "snapshot" so it can be filtered.

In addition to the rules above, also extract project build/stack details when present (build commands, test commands, dependency update policy, short stack summary). Use type="semantic" for build/stack and type="procedural" for the dependency update policy.

SCOPE — every candidate also carries a scope field that decides which store the row lands in:

* "project" (default if omitted) — facts about the active repository, its conventions, its current state. Lives in the per-project DB and surfaces only when the user is in this project.
* "global" — cross-project facts the agent should recall no matter which repository is open. Use ONLY for:
    * user preferences ("user prefers dark mode", "user always runs npm run check before commit")
    * environment facts ("GitHub handle is cbunt", "default shell is bash")
    * reusable procedures ("to onboard on a new machine: …")
    * cross-project conventions or policies the user has stated
  When in doubt, default to "project" — over-classifying as global pollutes the cross-project store and dilutes recall.

Respond with a JSON array. Each entry: { "type": "semantic"|"episodic"|"procedural"|"context_snapshot", "scope": "project"|"global" (optional, defaults to "project"), "title": "<=80 chars", "content": "<=500 chars", "tags": ["<short tag>", ...] }.

Aim for 3-6 candidates per call: a mix of durable facts (semantic / episodic / procedural) and at least one context_snapshot whenever the conversation describes current state, an in-flight task, or a stated plan. At most one global candidate per call; the cross-project store should grow slowly. Return [] only when the transcript is genuinely empty of state worth recalling. No prose, no markdown fences — JSON only.`;

// Stack-tool patterns. Each entry matches the tool's name (word-boundary)
// anywhere in a script body — so `jest --watch`, `npx jest`, and
// `node ./node_modules/.bin/jest` all trigger the "jest" tag. The
// detector scans every script in package.json, not just `build` /
// `test`, so a `lint:fix: "eslint --fix"` still surfaces "eslint".
//
// The previous detector only matched devDependency names (`typescript`
// in deps, `packageManager` field), which left bare-Node projects
// (no `packageManager`, no `typescript` dep, `scripts.test: "node
// --test"`) labeled as `Stack: unknown` — useless for the agent. The
// regex scan covers that common case without requiring the manifest
// to declare each tool as a dependency. A false positive here is
// harmless: the tag is informational, not authoritative.
const STACK_TOOL_PATTERNS = [
  // Test runners (most common bare-Node case is `node --test`)
  { re: /\bnode\s+--test\b/, tag: 'node (test runner)' },
  { re: /\bjest\b/, tag: 'jest' },
  { re: /\bvitest\b/, tag: 'vitest' },
  { re: /\bmocha\b/, tag: 'mocha' },
  { re: /\bava\b/, tag: 'ava' },
  { re: /\btap\b/, tag: 'tap' },
  // TypeScript variants
  { re: /\btsc\b/, tag: 'typescript (compiler)' },
  { re: /\btsx\b/, tag: 'tsx' },
  { re: /\bts-node\b/, tag: 'ts-node' },
  // Bundlers / build orchestrators
  { re: /\bvite\b/, tag: 'vite' },
  { re: /\bwebpack\b/, tag: 'webpack' },
  { re: /\brollup\b/, tag: 'rollup' },
  { re: /\besbuild\b/, tag: 'esbuild' },
  { re: /\bparcel\b/, tag: 'parcel' },
  { re: /\bturbo\b/, tag: 'turbo' },
  { re: /\bnx\b/, tag: 'nx' },
  // Linters / formatters (informational)
  { re: /\beslint\b/, tag: 'eslint' },
  { re: /\bprettier\b/, tag: 'prettier' },
];

// Scan every script body for stack-tool matches. Each tag is emitted
// at most once even if multiple scripts reference the same tool —
// duplicates in `stack` would pollute the surfaced memory.
function detectStackTools(scripts, stack) {
  if (!scripts || typeof scripts !== 'object') return;
  const seen = new Set(stack);
  for (const body of Object.values(scripts)) {
    if (typeof body !== 'string' || !body) continue;
    for (const { re, tag } of STACK_TOOL_PATTERNS) {
      if (seen.has(tag)) continue;
      if (re.test(body)) {
        stack.push(tag);
        seen.add(tag);
      }
    }
  }
}

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
    const pkgParsed = safeJsonParse(pkgText);
    const pkg = pkgParsed.ok ? pkgParsed.value : null;
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
    const hasTypeScript = depNames.some((d) => d === 'typescript' || d.startsWith('@types/'));
    if (hasTypeScript) out.stack.push('typescript');
    // Regex-based tool detection: covers bare-Node projects
    // (scripts.test: "node --test"), script-invoked tooling
    // (`npx jest`), and devDeps the manifest forgot to declare.
    detectStackTools(scripts, out.stack);
  } catch {
    // package.json missing or unparseable — ignore
  }

  try {
    const tsPath = path.join(cwd, 'tsconfig.json');
    const tsText = await fs.readFile(tsPath, 'utf8');
    const tsParsed = safeJsonParse(tsText);
    const ts = tsParsed.ok ? tsParsed.value : null;
    if (
      ts &&
      typeof ts === 'object' &&
      ts.compilerOptions &&
      typeof ts.compilerOptions === 'object'
    ) {
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
  if (!out.updatePolicy)
    out.updatePolicy = 'Check for latest unless pinned or specified in manifest';
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
  const baseUrl = asString(providerBlock.base_url);
  // SSRF hardening (opt-in). Disabled by default because the local-first
  // threat model treats the user's own config.toml as trusted, and a
  // user who points their provider at a self-hosted OpenAI-compatible
  // proxy on `http://127.0.0.1:8080` would otherwise see the auto-
  // extract path silently disabled. Operators with hardened configs
  // turn it on via `KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS=1` to
  //   - refuse cleartext `http://` base URLs, and
  //   - block loopback / private / link-local hosts that would let a
  //     tampered config exfiltrate the redacted transcript to an
  //     attacker-controlled endpoint.
  // Refusal is fail-open in the sense that the hook reports a count
  // and moves on; we never crash the agent lifecycle.
  // (Production-readiness review finding F-6.)
  if (process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS === '1') {
    const guarded = guardLlmBaseUrl(baseUrl);
    if (!guarded.ok) {
      return { error: `base_url_blocked:${guarded.reason}`, baseUrl };
    }
  }
  return {
    provider: providerName,
    model: asString(modelBlock.model) || defaultModel,
    apiKey: asString(providerBlock.api_key),
    baseUrl,
    type: asString(providerBlock.type) || 'openai',
  };
}

// WHATWG `URL` already normalises the alternative IPv4 spellings
// (decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f000001`, short
// `127.1`, userinfo `user@127.0.0.1`) down to a dotted quad, so those do
// not need a second implementation here. What it does NOT tell us is
// whether that quad is routable, which is the classification below.
//
// The two textual normalisations the range tests need:
//   - IPv6 hostnames keep their brackets (`[::1]`), which no prefix test
//     would ever match;
//   - a trailing dot is legal DNS (`localhost.`) but compares unequal to
//     the bare name.
function normalizeHostname(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

// Non-routable / internal IPv4 blocks, tested by octet so the table stays
// auditable: 0.0.0.0/8 ("this network"), 10/8, the whole of 127/8 (the
// old check only knew 127.0.0.1 — every other 127.x.y.z is equally
// loopback), 169.254/16 (link-local; contains the cloud metadata service
// at 169.254.169.254), 172.16/12 and 192.168/16.
function isPrivateIpv4(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// `new URL()` emits IPv6 in canonical compressed form, but `::` keeps the
// textual layout variable, so byte offsets are not stable. Expand to eight
// fixed-width hextets (32 hex digits) instead, which makes every prefix
// test below a plain string compare. Returns null when the text is not a
// valid IPv6 address.
function expandIpv6Parts(addr) {
  let text = String(addr || '');
  let v4 = [];
  const dotted = /(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    v4 = [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
    text = text.slice(0, text.length - dotted[2].length);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const parts = [...left, ...right, ...v4];
  const need = 8 - parts.length;
  if (halves.length === 2) {
    if (need < 0) return null;
    parts.splice(left.length, 0, ...Array(need).fill('0'));
  } else if (need !== 0) {
    return null;
  }
  if (parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return parts.map((h) => h.padStart(4, '0')).join('');
}

// ::ffff:0:0/96 — the IPv4-mapped prefix. Addresses inside it carry a real
// IPv4 address in their low 32 bits, so they are classified by the IPv4
// table rather than as IPv6.
const IPV6_V4MAPPED_PREFIX = '0'.repeat(20) + 'ffff';

function isPrivateIpv6(addr) {
  const hex = expandIpv6Parts(addr);
  if (!hex) return false;
  // fc00::/7 — unique local addresses.
  if ((parseInt(hex.slice(0, 2), 16) & 0xfe) === 0xfc) return true;
  // fe80::/10 — link-local.
  if ((parseInt(hex.slice(0, 4), 16) & 0xffc0) === 0xfe80) return true;
  // Every other non-public IPv6 shape puts an IPv4 address in the low 32
  // bits: ::ffff:0:0/96 (IPv4-mapped, e.g. ::ffff:169.254.169.254) and the
  // all-zero high 96 bits of :: , ::1 and the deprecated IPv4-compatible
  // ::a.b.c.d form. One IPv4 table then covers them all.
  const high = hex.slice(0, 24);
  if (high === IPV6_V4MAPPED_PREFIX || high === '0'.repeat(24)) {
    const v4 = [0, 2, 4, 6].map((i) => parseInt(hex.slice(24 + i, 26 + i), 16)).join('.');
    return isPrivateIpv4(v4);
  }
  return false;
}

// True when the host must never receive the (redacted) transcript. DNS
// names are deliberately not resolved — the guard stays deterministic and
// offline — so the only name it can judge is `localhost`.
function isPrivateHost(host) {
  if (host === 'localhost') return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) return isPrivateIpv6(host);
  return false;
}

// Pure helper: returns { ok, reason } describing whether a base URL is
// acceptable for the auto-extract LLM call under the
// `KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS=1` hardening policy.
//
// Accepts:
//   - https://host[:port]/path  to a public IP or a DNS name.
// Refuses:
//   - every cleartext `http://` base URL, public or not. The variable is
//     named REQUIRE_HTTPS and the operator who sets it expects TLS on all
//     traffic; the earlier "public http is fine" carve-out contradicted
//     that (and AGENTS.md / SECURITY.md already documented the strict
//     reading).
//   - any URL whose host is a loopback / private / link-local / ULA
//     address, whatever the scheme. An SSRF target is a target whether or
//     not the connection is encrypted — `https://169.254.169.254/` is not
//     a legitimate provider.
//   - any non-http(s) scheme (file://, ssh://, etc.).
// (Production-readiness review finding F-6.)
export function guardLlmBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'no_base_url' };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unparseable_url' };
  }
  const scheme = (url.protocol || '').replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, reason: `unsupported_scheme:${scheme || 'unknown'}` };
  }
  const host = normalizeHostname(url.hostname);
  if (isPrivateHost(host)) {
    return {
      ok: false,
      reason: scheme === 'http' ? `cleartext_local:${host}` : `private_host:${host}`,
    };
  }
  if (scheme === 'http') {
    return { ok: false, reason: `cleartext_http:${host}` };
  }
  return { ok: true };
}

// Build the extraction prompt. existingTitles is a list of titles
// already in the project's active memories; listing them nudges the
// model away from duplicates the dedup pass would also catch.
//
// The transcript is redacted with redactSecrets before being inserted
// into the user message. The LLM call now sees a sanitised view —
// credentials in the conversation never leave the machine, even when
// the user typed them in chat. (Audit finding H3 / B3-1.)
function buildExtractionPrompt(transcript, existingTitles, projectMeta) {
  const trimmed = redactSecrets(String(transcript || '')).slice(0, MAX_INPUT_CHARS);
  const titlesLine =
    existingTitles && existingTitles.length
      ? `\nFor dedup, here are titles already in this project's memory (avoid repeating these):\n- ${existingTitles.slice(0, 50).join('\n- ')}\n`
      : '';
  // Defensive JSON.stringify for project metadata: a caller that
  // passes a projectMeta with a circular reference or a BigInt would
  // otherwise throw out of `buildExtractionPrompt` and turn the
  // auto-extract path into a hard error. `detectProjectMetadata`
  // only produces primitive data, so today this is latent — but
  // the prompt shape is part of the contract and `JSON.stringify`
  // failures should fall back to a safe-default literal rather
  // than crashing the Stop hook. (Audit fix BUG-15.)
  const safeStringify = (v) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return '{}';
    }
  };
  // Project metadata is serialised JSON pulled from manifest files in
  // the active project. Redact it too — a secret-bearing build script
  // would otherwise leave the machine unchanged while a credential
  // copy ships to the LLM. (Audit finding F-003.)
  const metaLine = projectMeta
    ? `\nProject metadata (from manifest files):\n${redactSecrets(safeStringify(projectMeta)).slice(0, MAX_INPUT_CHARS)}\n`
    : '';
  return {
    system: EXTRACT_SYSTEM_PROMPT,
    user: `${titlesLine}${metaLine}Conversation transcript:\n"""\n${trimmed}\n"""\n\nJSON array of candidate memories:`.slice(
      0,
      MAX_INPUT_CHARS,
    ),
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
    const type = asString(raw.type);
    if (!['semantic', 'episodic', 'procedural', 'context_snapshot'].includes(type)) continue;

    const title = asString(raw.title).slice(0, 500);
    const content = asString(raw.content).slice(0, 4000);
    if (!content) continue;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 64).slice(0, 16)
      : [];
    // Scope: optional, defaults to project. A candidate whose scope is
    // any value other than 'global' or 'project' is treated as project
    // (we never reject the whole batch for one bad scope — the type +
    // content validation already passed and the candidate is otherwise
    // useful). Global classification is opt-in by the model, never
    // silent — the dispatcher's default branch handles the value the
    // model wrote, not the absence of one.
    const scopeRaw = raw.scope;
    const scope = scopeRaw === 'global' ? 'global' : 'project';
    out.push({ type, scope, title, content, tags });
    if (out.length >= MAX_CANDIDATES_PER_CALL) break;
  }
  return out;
}

// A non-OK response used to collapse to a bare `null`, which the retry
// classifier could not tell apart from an empty 200 body: a permanent 401
// burned the whole attempt budget and `logAutoExtractError` never recorded
// the HTTP cause. Throwing a structured error keeps both the numeric
// status (`code`, which `withLlmRetry` classifies) and the reason
// (`message`, which reaches the diagnostic log).
function llmHttpError(endpoint, res) {
  const err = new Error(`llm_http_${res.status} ${endpoint}`);
  err.code = res.status;
  err.status = res.status;
  return err;
}

// Call a chat-completion endpoint. Supports both OpenAI-compatible and
// Anthropic-compatible providers (the two types declared in the config).
//
// Returns the assistant text on success, `null` when the response was
// well-formed but carried no usable text (the empty-reply case the retry
// exists for), and throws a structured error for an HTTP or transport
// failure so the caller's retry wrapper can tell a permanent 4xx from a
// transient 5xx.
export async function callChat({ apiKey, baseUrl, type, model, system, user, signal }) {
  if (!apiKey || !baseUrl) return null;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());
  try {
    const url = baseUrl.replace(/\/+$/, '');
    // `redirect: 'error'` on both calls. The base-URL guard only ever sees
    // the URL read from config.toml, so following a 307/308 from a public
    // host would re-POST the transcript wherever the Location header
    // points — including http://169.254.169.254/ or a loopback port. A
    // provider that legitimately redirects must be configured with its
    // final URL; do not relax this back to the undici default 'follow'.
    if (type === 'anthropic') {
      const endpoint = '/v1/messages';
      const res = await fetch(`${url}${endpoint}`, {
        method: 'POST',
        redirect: 'error',
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
      if (!res.ok) throw llmHttpError(endpoint, res);
      const body = await res.json();
      const parts = body && body.content;
      if (!Array.isArray(parts)) return null;
      return parts
        .map((p) => (p && p.text) || '')
        .join('')
        .trim();
    }
    // OpenAI-compatible (covers openai, nvidia, poolside, stepfun, …).
    const endpoint = '/chat/completions';
    const res = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      redirect: 'error',
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
    if (!res.ok) throw llmHttpError(endpoint, res);
    const body = await res.json();
    const choice = body && body.choices && body.choices[0];
    const msg = choice && choice.message;
    return msg && typeof msg.content === 'string' ? msg.content.trim() : null;
  } catch (e) {
    if (e && e.status) throw e;
    // Transport failure or our own timeout. undici reports the socket
    // cause on `error.cause` (ECONNRESET / ENOTFOUND / …); carry it into
    // the message and the `code` so the classifier sees a transient
    // failure instead of the bare `fetch failed` the previous
    // `return null` hid entirely. An abort from our own timeout maps to
    // ETIMEDOUT.
    const cause = e && e.cause;
    const causeMessage = cause && cause.message ? `: ${cause.message}` : '';
    const err = new Error((e && e.message ? e.message : 'llm_call_failed') + causeMessage);
    if (e && e.name === 'AbortError') {
      err.message = `llm_call_timeout after ${LLM_TIMEOUT_MS}ms`;
      err.code = 'ETIMEDOUT';
    } else if (e && e.code) {
      err.code = e.code;
    } else if (cause && cause.code) {
      err.code = cause.code;
    }
    throw err;
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
  // Optional: when a candidate carries `scope: 'global'`, dedupe
  // against the global DB instead of the project DB. Without this,
  // every "user prefers dark mode" candidate would walk the project
  // title-overlap stage and never see the cross-project rows that
  // actually own the concept.
  globalDb = null,
  globalProjectKey = '_global',
}) {
  const kept = [];
  const duplicates = [];
  // Stage 1: bound to the most recent 500 active rows so a 50k-corpus
  // doesn't stall the Stop hook. The cheap overlap check runs in
  // O(candidates × titles) inside the limit. Duplicates that survive
  // stage 1 still hit the hybrid recall in stage 2.
  // (Audit finding F-008.)
  const DEDUPE_TITLE_LIMIT = 500;

  function loadExisting(scopeDb, scopeKey) {
    return scopeDb
      .prepare(
        `SELECT id, title, content FROM memories
         WHERE project_key = ? AND status = 'active'
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT ${DEDUPE_TITLE_LIMIT}`,
      )
      .all(scopeKey)
      .map((r) => ({
        id: r.id,
        title: r.title || '',
        titleTokens: tokenizeTitle(r.title || ''),
        content: r.content || '',
      }));
  }

  // Cache per-scope: project candidates dedupe against the project
  // corpus once; global candidates dedupe against the global corpus
  // once. Mixing them inside one prepare would either over-fetch or
  // miss rows; one cache per scope keeps the bound honest.
  const existingByScope = new Map();
  function existingFor(scopeKey, scopeDb) {
    if (!existingByScope.has(scopeKey)) {
      existingByScope.set(scopeKey, loadExisting(scopeDb, scopeKey));
    }
    return existingByScope.get(scopeKey);
  }

  for (const cand of candidates) {
    const candTitleTokens = tokenizeTitle(cand.title || '');
    // Pick the dedupe target by scope. Global candidates must not be
    // checked against project rows, and vice versa.
    const isGlobal = cand.scope === 'global';
    const targetDb = isGlobal ? globalDb : db;
    const targetKey = isGlobal ? globalProjectKey : projectKey;
    if (!targetDb) {
      // No DB for this scope (e.g. global DB not yet created on a
      // fresh install). Skip dedupe rather than throwing — the save
      // path will create the DB on first write.
      kept.push(cand);
      continue;
    }
    const existing = existingFor(targetKey, targetDb);
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
      hits = await searchMemories(targetDb, targetKey, (cand.title || cand.content || '').trim(), {
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
  // Optional second DB for cross-project (global) candidates. The
  // caller (handleAutoExtract) opens both stores once per Stop hook
  // and passes the handles in. When omitted, every candidate is
  // treated as project-scoped regardless of the model's `scope`
  // field — the original behaviour, preserved for tests that don't
  // exercise the global path.
  globalDb = null,
  globalProjectKey = '_global',
  // Injection seam for tests + future override (e.g. KIMI_MEMORY_AUTO_EXTRACT_LLM).
  callLlm = callChat,
  resolveLlmTargetImpl = resolveLlmTarget,
  now = () => Date.now(),
  // Env-driven opt-outs. Tests can override the default.
  isDisabled = () => process.env.KIMI_MEMORY_AUTO_EXTRACT === 'off',
  // Independent opt-out for the global path. Defaults to on. Setting
  // KIMI_MEMORY_AUTO_EXTRACT_GLOBAL=off disables the cross-project
  // branch while leaving the project branch running, so operators
  // who do not want the cross-project store growing automatically
  // can keep it frozen without losing the per-project signal.
  isGlobalDisabled = () => process.env.KIMI_MEMORY_AUTO_EXTRACT_GLOBAL === 'off',
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
    global_saved: 0,
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
    // Retry with exponential backoff for transient LLM failures. Two
    // attempts, not three: each attempt can burn LLM_TIMEOUT_MS (4s) and
    // the Stop-hook dispatcher kills the pass at 14s
    // (src/hooks/run.js HOOK_TIMEOUTS_MS.Stop), so worst case here is
    // 2 x 4s + one 1000ms-capped backoff ≈ 9.1s. A third attempt would
    // reach ~14s and be killed mid-flight, losing the pass entirely.
    reply = await withLlmRetry(
      () => callLlm({ ...target, system: prompt.system, user: prompt.user }),
      { projectKey, maxAttempts: 2, baseDelayMs: 1000 },
    );
  } catch (error) {
    // LLM call failed after retries; log and continue with no extraction.
    await logAutoExtractError(projectKey, 'llm_failed_after_retries', error, {
      max_attempts: 2,
      error_code: error?.code,
    }).catch(() => {});
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

  // The global path is opt-out via env. When disabled, every candidate
  // is forced to project scope so the model can still emit `scope:
  // "global"` but the dispatcher reroutes it. This keeps the model
  // honest (it still classifies) without writing to the cross-project
  // store — useful for operators who prefer to promote manually.
  const globalDisabled = isGlobalDisabled();
  const normalizedCandidates = globalDisabled
    ? candidates.map((c) => ({ ...c, scope: 'project' }))
    : candidates;

  const { kept, duplicates } = await dedupeCandidates({
    db,
    projectKey,
    candidates: normalizedCandidates,
    searchMemories,
    globalDb,
    globalProjectKey,
  });
  result.duplicates = duplicates.length;

  const deterministic = [];
  if (projectMeta) {
    const stack =
      projectMeta.stack && projectMeta.stack.length ? projectMeta.stack.join(', ') : 'unknown';
    deterministic.push({
      type: 'semantic',
      scope: 'project',
      title: 'Project build/stack details',
      content: `Stack: ${stack}. Build: ${projectMeta.buildCommand || 'n/a'}. Test: ${projectMeta.testCommand || 'n/a'}. Update policy: ${projectMeta.updatePolicy || 'n/a'}.`,
      tags: ['build', 'stack', 'project'],
      supersede: true,
    });
    if (projectMeta.updatePolicy) {
      deterministic.push({
        type: 'procedural',
        scope: 'project',
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
    // operator can see what was suppressed. Secret scan runs once
    // and gates both the project and the global save path.
    if (secretDetector(cand.content) || secretDetector(cand.title)) {
      result.secrets_dropped += 1;
      continue;
    }
    try {
      // Snapshot candidates rank below durable facts so they don't
      // crowd out recall of conventions, decisions, and procedures.
      // The confounder — the LLM may over-snapshot — is offset by
      // ranking alone: durable facts surface first in default order,
      // snapshots still come up via FTS5 search on the next session.
      const isSnapshot = cand.type === 'context_snapshot';
      const isGlobal = cand.scope === 'global';
      const targetSaveDb = isGlobal ? globalDb : db;
      const targetSaveKey = isGlobal ? globalProjectKey : projectKey;
      if (!targetSaveDb) {
        // No global DB on a fresh install — keep the candidate alive
        // for next time rather than dropping it silently. The save
        // path will lazily create the DB on first write.
        if (isGlobal) {
          result.error = 'global_db_unavailable';
          continue;
        }
        result.error = 'project_db_unavailable';
        continue;
      }
      saveMemory(targetSaveDb, targetSaveKey, {
        type: cand.type,
        title: cand.title,
        content: cand.content,
        tags: cand.tags,
        confidence: isSnapshot ? 0.45 : 0.6, // snapshots rank lowest
        priority: isSnapshot ? -3 : -1, // snapshots below other auto-extract rows
        provenance: {
          source: 'auto_extract',
          scope: isGlobal ? 'global' : 'project',
          model: target.model,
          provider: target.provider,
          cwd: cwd || null,
          recorded_at: nowIso(),
        },
      });
      result.saved += 1;
      if (isGlobal) result.global_saved += 1;
    } catch (e) {
      // Never block: a single failed save is logged via result.error and
      // the next candidate proceeds.
      result.error = e && e.message ? e.message : String(e);
    }
  }
  return result;
}
