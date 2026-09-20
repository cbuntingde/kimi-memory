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
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z ]*?(?:PRIVATE|OPENSSH PRIVATE) KEY-----[\s\S]*?-----END [A-Z ]*?PRIVATE KEY-----/g;

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
  out = out.replace(PEM_BLOCK_RE, '[REDACTED_PEM_BLOCK]');
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
