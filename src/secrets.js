// Credential detection and redaction.
//
// This is a leaf module on purpose. The storage layer's write gate
// (`assertNoSecret` in persist/memories.js) and the conversation-archive
// writer (persist/project.js) both depend on it, so it must not import
// the extractor, the embedding model, or anything in persist/. It has no
// project imports at all.
//
// Two consumers, two directions:
//   * `looksLikeSecret(text)`  — the gate. True means "refuse to persist".
//   * `redactSecrets(text)`    — the scrubber. Replaces each match with a
//     stable `[REDACTED_*]` token so the structure of the text survives
//     while the credential bytes do not.
//
// A credential shape must be handled by BOTH: detecting a shape we do not
// scrub means the secret is refused at the save gate but still shipped to
// the model on the auto-extract path; scrubbing a shape we do not detect
// is harmless. `tests/49-secret-coverage.test.js` asserts that every
// sample in the corpus is detected *and* that its redacted form is no
// longer detected, which is what prevents the two halves from drifting.
//
// False positives are accepted by design: dropping a candidate that
// mentions a generic "token" is far cheaper than persisting a real one.

// ---------------------------------------------------------------------
// Provider-key shapes: prefix-anchored, high confidence.
//
// One source string drives both the detector and the scrubber so a new
// provider cannot be added to one and silently missed by the other.
// ---------------------------------------------------------------------
const PROVIDER_KEY_SOURCE = [
  'sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}', // OpenAI incl. sk-proj-, Anthropic
  '(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}', // Stripe
  'xox[baprs]-[A-Za-z0-9-]{10,}', // Slack
  '(?:AKIA|ASIA)[0-9A-Z]{16}', // AWS access key id
  'gh[pousr]_[A-Za-z0-9]{20,}', // GitHub PAT / OAuth / app / refresh
  'github_pat_[A-Za-z0-9_]{20,}', // GitHub fine-grained PAT
  'glpat-[A-Za-z0-9_-]{20,}', // GitLab PAT
  'npm_[A-Za-z0-9]{36}', // npm automation token
  'hf_[A-Za-z0-9]{30,}', // Hugging Face
  'AIza[0-9A-Za-z_-]{35}', // Google API key
  'GOCSPX-[A-Za-z0-9_-]{16,}', // Google OAuth client secret
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}', // SendGrid API key
  'https://hooks\\.slack\\.com/services/[A-Za-z0-9_/-]{20,}', // Slack incoming webhook
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
].join('|');

const PROVIDER_KEY_RE = new RegExp(`\\b(?:${PROVIDER_KEY_SOURCE})\\b`);
const PROVIDER_KEY_RE_G = new RegExp(`\\b(?:${PROVIDER_KEY_SOURCE})\\b`, 'g');

// ---------------------------------------------------------------------
// Assigned secrets: `name = value` / `"name": "value"` / `name value`.
//
// The leading boundary accepts any non-alphanumeric character, so a
// JSON-encoded or TOML-encoded key (`{"api_key": "…"}`), a CLI flag
// (`--api-key=…`), a dotted or slashed name all match. A name therefore
// still has to start a token; only the set of legal separators widened.
//
// The name alternation carries an optional dotted/underscored prefix
// (bounded, to keep backtracking flat) so `AWS_SECRET_ACCESS_KEY` and
// `MY_SERVICE_TOKEN` are covered by the `secret_access_key` / `token`
// alternatives.
//
// The value class allows `/`, `+`, `=`, `:`, `@`, `.`, `-` so base64
// blobs and connection strings are consumed whole.
// ---------------------------------------------------------------------
const SECRET_NAME_SOURCE =
  '(?:[A-Za-z0-9]{1,32}[_.-]){0,4}' +
  '(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token|access[_-]?token|auth[_-]?token|' +
  'bearer[_-]?token|refresh[_-]?token|id[_-]?token|secret[_-]?access[_-]?key|' +
  'access[_-]?key[_-]?id|shared[_-]?access[_-]?key|account[_-]?key|secret[_-]?key|' +
  'client[_-]?secret|private[_-]?key|signing[_-]?key|password|passwd|pwd|token|secret)';

// The boundary is a CAPTURING group (and the value is not) so the
// redaction replacement can put the boundary back with `$1`. Getting
// this backwards silently leaves the secret bytes in the output while
// still appending the token — see tests/49-secret-coverage.test.js,
// which asserts the original bytes are gone.
//
// The class is "anything that is not a letter or digit" rather than an
// explicit separator list: a name always begins a token, and the four
// separators the previous `[\s,;{\[(]` class omitted are the common
// ones — `--api-key=…` (dash), `com.example.api_key=…` (dot),
// `conf/token=…` (slash) and `NAME=value` (the `=` of the assignment).
const ASSIGNMENT_BOUNDARY = '(^|[^A-Za-z0-9])';
const ASSIGNMENT_SOURCE = `${ASSIGNMENT_BOUNDARY}["']?${SECRET_NAME_SOURCE}["']?\\s*[:=]\\s*["']?(?:[^\\s"',;]{8,})`;
const ASSIGNMENT_RE = new RegExp(ASSIGNMENT_SOURCE, 'i');
const ASSIGNMENT_RE_G = new RegExp(ASSIGNMENT_SOURCE, 'gi');

// Whitespace-separated form: `AWS_SECRET_ACCESS_KEY <value>`. The `=`
// form above misses it because the value class stops at whitespace.
//
// Two lookaheads keep ordinary prose out. The value must be at least 16
// characters, and it must contain a digit — real credentials almost
// always carry one, while the long English words that follow a key-ish
// noun ("token authentication", "secret management", "password
// implementation", "token case-insensitive") do not.
const ASSIGNMENT_WS_SOURCE =
  `${ASSIGNMENT_BOUNDARY}["']?${SECRET_NAME_SOURCE}["']?[ \\t]+` +
  '(?=[^\\s"\',;]{16,})(?=[^\\s"\',;]*[0-9])[^\\s"\',;]+';
const ASSIGNMENT_WS_RE = new RegExp(ASSIGNMENT_WS_SOURCE, 'i');
const ASSIGNMENT_WS_RE_G = new RegExp(ASSIGNMENT_WS_SOURCE, 'gi');

// ---------------------------------------------------------------------
// Connection strings that embed a username:password pair.
//
// The authority has to carry a `user:pass@` pair, so a plain
// `DATABASE_URL=postgres://localhost/db` (no credentials) is left alone.
//
// The name part is optional so a bare URL whose authority carries a
// user:password pair is caught on its own. It is deliberately
// unconstrained rather than the old `…(?:url|dsn|uri|connection_string)`
// list: when the name is present the whole `NAME=url` pair has to be
// consumed, otherwise redacting only the URL leaves `DB_PASSWORD=`
// behind and the leftover re-matches the assignment rule on the next
// pass.
//
// Every quantifier inside the URL is bounded and the userinfo classes
// exclude `/` (RFC 3986 does not allow `/` in userinfo). Together that
// is what keeps the scan from degenerating on input that contains many
// `://` and no `@`: without the `/` exclusion the engine rescans the
// length of the password bound at every `://` site. The scanner runs on
// every write, so this matters more than the unlikely password with a
// literal slash in it.
// ---------------------------------------------------------------------
const CONNECTION_NAME_SOURCE = '["\']?[A-Za-z0-9_.-]{0,64}["\']?\\s*[:=]\\s*["\']?';
const CONNECTION_URL_SOURCE =
  '[a-z][a-z0-9+.-]{0,32}://[^\\s"\',;@/:]{1,64}:[^\\s"\',;@/]{0,128}@[^\\s"\',;]{1,256}';
const CONNECTION_SOURCE = `${ASSIGNMENT_BOUNDARY}(?:${CONNECTION_NAME_SOURCE})?(?:${CONNECTION_URL_SOURCE})`;
const CONNECTION_RE = new RegExp(CONNECTION_SOURCE, 'i');
const CONNECTION_RE_G = new RegExp(CONNECTION_SOURCE, 'gi');

const PEM_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// PEM block redaction is a linear indexOf scanner, not a regex.
//
// The regex it replaces — `-----BEGIN … KEY-----[\s\S]*?-----END … KEY-----`
// — is quadratic on a session tail that contains many `-----BEGIN` headers,
// because a lazy quantifier that fails must retry from every start
// position: measured through redactSecrets on a tail of repeated headers
// (the shape a pasted key repeated across a long session produces), 512 KB
// cost ~273 ms, 1.25 MB ~1724 ms and 2.5 MB ~6978 ms — five times the input
// for twenty-five times the work. This runs on a raw wire line with no size
// limit, under a 14 s Stop budget (src/hooks/run.js), so a large tail could
// kill the pass before the ingest-state write landed.
//
// Bounding the body does not fix that. A bounded lazy quantifier loses
// V8's literal-lookahead fast path, so 512 KB measured 2814 ms with the
// 64 KiB cap — worse, not better — and a "skip the pass when the text holds
// no END marker" pre-check only covers the zero-marker case: one stray
// `-----END` at the end of the text still cost 3355 ms, and four spread
// through it 1292 ms (14.7 s and 13.5 s at 2.5 MB). The scanner below does
// that block step in 0.6 ms / 2.4 ms / 0.9 ms on those three inputs, and the
// whole of redactSecrets — the other passes over the same text included —
// in ~27 ms / ~25 ms / ~14 ms at 512 KB and ~130 ms at 2.5 MB: about 5x the
// work for 5x the input.
//
// How it stays linear: every well-formed END footer is located ONCE in a
// forward pass (each indexOf resumes past the marker it found, so the total
// scanned bytes is the text length), then one forward-only pointer walks
// that list while the BEGIN positions advance. No position is ever rescanned
// for a second BEGIN, and when the pointer runs off the end of the list no
// later BEGIN can match either, so the rest of the text is copied verbatim
// in one slice. The per-BEGIN header/footer parses are sticky-anchored, so
// each is a bounded check at a fixed offset rather than a search.
//
// The 64 KiB body cap is kept as defence in depth: it is not needed for the
// timing any more, but it stops one stray BEGIN from swallowing a distant
// END and redacting megabytes as a single "key". An over-long block is not
// redacted as one unit — that was already true of the capped regex this
// scanner replaces; the pre-cap unbounded regex did claim it. What matters
// is that such a block is still DETECTED, by PEM_HEADER_RE above, which is
// the half that makes looksLikeSecret refuse to persist it. The scanner
// claims exactly the spans the capped regex claimed, so no shape loses
// scrub coverage it had.
const PEM_BODY_MAX_CHARS = 65536;

// Anchored parses of the two header forms. Sticky, so `exec` starts exactly
// at `lastIndex` and the cost is the header's own length, never a search.
const PEM_BEGIN_AT_RE = /-----BEGIN [A-Z ]*?(?:PRIVATE|OPENSSH PRIVATE) KEY-----/y;
const PEM_END_AT_RE = /-----END [A-Z ]*?PRIVATE KEY-----/y;

// Parse `re` anchored at exactly `at`. Returns the end offset of the match
// or -1. Both callers below hold a candidate offset from an indexOf, so an
// unanchored search would be both slower and wrong. The `m.index === at`
// test is belt-and-braces on the `y` flag: a sticky `exec` always reports
// the match at `lastIndex`, so it can only fire if someone drops that flag —
// and a silent fallback to an unanchored search would shift every offset
// used in the splice below, which is data loss in a redaction path.
function matchAt(text, re, at) {
  re.lastIndex = at;
  const m = re.exec(text);
  return m && m.index === at ? at + m[0].length : -1;
}

function redactPemBlocks(text) {
  // Every END footer that could terminate a block, in one forward pass.
  // A position that does not parse as a full footer can never parse for any
  // BEGIN, so filtering here (rather than per BEGIN) keeps the walk below
  // bounded by the number of real footers. `p + 8` cannot skip an overlapping
  // occurrence: '-----END' does not contain itself off-phase, the same way
  // '-----BEGIN' does not.
  const ends = [];
  for (let p = text.indexOf('-----END'); p >= 0; p = text.indexOf('-----END', p + 8)) {
    const end = matchAt(text, PEM_END_AT_RE, p);
    if (end >= 0) ends.push({ start: p, end });
  }
  if (ends.length === 0) return text;
  // Two cursors: `flushed` is how far the output has been emitted, `i` is
  // where the next BEGIN search starts. They diverge as soon as a header
  // fails to parse (the scan moves on, but nothing has been copied yet), so
  // one cursor cannot serve both.
  let out = '';
  let flushed = 0;
  let i = 0;
  let endPtr = 0;
  while (i < text.length) {
    const begin = text.indexOf('-----BEGIN', i);
    if (begin < 0) break;
    const headerEnd = matchAt(text, PEM_BEGIN_AT_RE, begin);
    // Not a private-key header ('-----BEGIN CERTIFICATE-----', a truncated
    // one). Resume one char on, exactly where a global regex's lastIndex
    // would have landed.
    if (headerEnd < 0) {
      i = begin + 1;
      continue;
    }
    while (endPtr < ends.length && ends[endPtr].start < headerEnd) endPtr++;
    // Every later BEGIN has a larger headerEnd, so if no footer is left at
    // or after this one, none is left for them either: stop scanning and
    // copy the remainder.
    if (endPtr >= ends.length) break;
    const cand = ends[endPtr];
    if (cand.start - headerEnd <= PEM_BODY_MAX_CHARS) {
      out += text.slice(flushed, begin) + '[REDACTED_PEM_BLOCK]';
      flushed = cand.end;
      i = cand.end;
      endPtr++;
    } else {
      i = begin + 1;
    }
  }
  if (flushed < text.length) out += text.slice(flushed);
  return out;
}

const BEARER_RE = /Authorization\s*:\s*Bearer\s+[A-Za-z0-9_.-]{20,}/i;
const BEARER_RE_G = /Authorization\s*:\s*Bearer\s+[A-Za-z0-9_.-]{20,}/gi;

const BASIC_RE = /Authorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{16,}/i;
const BASIC_RE_G = /Authorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{16,}/gi;

// ---------------------------------------------------------------------
// High-entropy fallback: bare tokens with no known prefix and no
// assignment name (`aB3d…`), the shape the audit matrix calls out as
// the last hole. Length and entropy alone cannot separate a random
// token from a long identifier, so the bar is deliberately
// conservative and the exclusions are explicit:
//
//   * `[A-Za-z0-9_+=-]` run of 32+ characters — base64 / base64url /
//     hex. `/` is excluded so filesystem paths and URLs do not become
//     one giant candidate.
//   * lower AND upper AND digit must all appear. That alone drops git
//     SHAs and UUIDs (hex, one case), snake_case and SCREAMING_SNAKE
//     identifiers, and all-lowercase no-space prose runs.
//   * entirely-hex runs are refused outright: a 40-char git SHA and a
//     40-char hex token are indistinguishable by entropy.
//   * Shannon entropy >= 4.5 bits/char. Random 40-char base64url tokens
//     measure ~4.5 and up (4.47 at p1, 4.78 at the median); camelCase
//     identifiers top out around 4.4. The threshold is above every
//     benign sample in tests/49-secret-coverage.test.js, which is what
//     keeps ordinary prose, paths and identifiers clean.
//
// Consequence, accepted on purpose: a 32-char random token whose
// characters happen to repeat enough to fall under the bar is missed.
// The false-positive direction is the expensive one here.
// ---------------------------------------------------------------------
const HIGH_ENTROPY_SOURCE = '[A-Za-z0-9_+=-]{32,}';
const HIGH_ENTROPY_RE = new RegExp(HIGH_ENTROPY_SOURCE, 'g');
const HIGH_ENTROPY_HEX_RE = /^[0-9a-fA-F]+$/;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.5;

function shannonBitsPerChar(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function isHighEntropyToken(token) {
  if (HIGH_ENTROPY_HEX_RE.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  return shannonBitsPerChar(token) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

function hasHighEntropyToken(text) {
  HIGH_ENTROPY_RE.lastIndex = 0;
  let m;
  while ((m = HIGH_ENTROPY_RE.exec(text)) !== null) {
    if (isHighEntropyToken(m[0])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------

// True if `text` appears to contain a credential. Used as the write gate
// and as the filter on auto-extracted candidates.
export function looksLikeSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  return (
    PROVIDER_KEY_RE.test(text) ||
    PEM_HEADER_RE.test(text) ||
    BEARER_RE.test(text) ||
    BASIC_RE.test(text) ||
    CONNECTION_RE.test(text) ||
    ASSIGNMENT_RE.test(text) ||
    ASSIGNMENT_WS_RE.test(text) ||
    hasHighEntropyToken(text)
  );
}

// ---------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------

// Replace every secret-shaped substring with a stable token. Idempotent:
// the emitted tokens contain no `=`/`:` assignment and no provider
// prefix, so they do not re-match.
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  out = out.replace(PROVIDER_KEY_RE_G, '[REDACTED_PROVIDER_KEY]');
  out = redactPemBlocks(out);
  out = out.replace(BEARER_RE_G, 'Authorization: Bearer [REDACTED]');
  out = out.replace(BASIC_RE_G, 'Authorization: Basic [REDACTED]');
  // Connection strings run before the generic assignment rule so the
  // credentials inside the URL are consumed by the more specific match.
  out = out.replace(CONNECTION_RE_G, '$1[REDACTED_CONNECTION_STRING]');
  out = out.replace(ASSIGNMENT_RE_G, '$1[REDACTED_ASSIGNED_SECRET]');
  out = out.replace(ASSIGNMENT_WS_RE_G, '$1[REDACTED_ASSIGNED_SECRET]');
  // Lowest confidence, so it runs last and never pre-empts a named shape.
  out = out.replace(HIGH_ENTROPY_RE, (m) =>
    isHighEntropyToken(m) ? '[REDACTED_HIGH_ENTROPY]' : m,
  );
  return out;
}

// Recursively redact every string value in a parsed JSON structure,
// preserving the structure itself. Used for the conversation archive,
// where the raw wire line must stay parseable (session-focus.js
// re-parses `conversation_events.payload` to recover a missing summary).
function redactStructure(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructure);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactStructure(value[k]);
    return out;
  }
  return value;
}

// Redact a serialised JSON payload while keeping it valid JSON.
//
// The fast path matters: this runs once per ingested wire line, and the
// vast majority of lines contain no credential. When nothing matches we
// return the original string untouched rather than paying for a
// parse/serialise round-trip.
//
// If the payload is not valid JSON we fall back to a plain textual
// scrub. The result may then be non-JSON, but it was already non-JSON.
export function redactPayload(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  if (!looksLikeSecret(raw)) return raw;
  try {
    return JSON.stringify(redactStructure(JSON.parse(raw)));
  } catch {
    return redactSecrets(raw);
  }
}
