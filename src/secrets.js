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
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
].join('|');

const PROVIDER_KEY_RE = new RegExp(`\\b(?:${PROVIDER_KEY_SOURCE})\\b`);
const PROVIDER_KEY_RE_G = new RegExp(`\\b(?:${PROVIDER_KEY_SOURCE})\\b`, 'g');

// ---------------------------------------------------------------------
// Assigned secrets: `name = value` / `"name": "value"`.
//
// The leading boundary accepts quote / brace / bracket / paren so a
// JSON-encoded or TOML-encoded key (`{"api_key": "…"}`) matches — the
// previous `[\s,;]`-only boundary missed every quoted key name, which
// is the single most common shape a credential appears in.
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
  '(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|auth[_-]?token|bearer[_-]?token|' +
  'refresh[_-]?token|id[_-]?token|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|' +
  'secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|secret)';

// The boundary is a CAPTURING group (and the value is not) so the
// redaction replacement can put the boundary back with `$1`. Getting
// this backwards silently leaves the secret bytes in the output while
// still appending the token — see tests/49-secret-coverage.test.js,
// which asserts the original bytes are gone.
const ASSIGNMENT_BOUNDARY = '(^|[\\s,;{\\[(])';
const ASSIGNMENT_SOURCE = `${ASSIGNMENT_BOUNDARY}["']?${SECRET_NAME_SOURCE}["']?\\s*[:=]\\s*["']?(?:[^\\s"',;]{8,})`;
const ASSIGNMENT_RE = new RegExp(ASSIGNMENT_SOURCE, 'i');
const ASSIGNMENT_RE_G = new RegExp(ASSIGNMENT_SOURCE, 'gi');

// ---------------------------------------------------------------------
// Connection strings that embed a username:password pair.
//
// Requires the `scheme://user:pass@host` shape, so a plain
// `DATABASE_URL=postgres://localhost/db` (no credentials) is left alone.
// ---------------------------------------------------------------------
const CONNECTION_SOURCE =
  `${ASSIGNMENT_BOUNDARY}["']?[A-Za-z0-9_.-]{0,64}(?:url|dsn|uri|connection[_-]?string)["']?\\s*[:=]\\s*["']?` +
  '(?:[a-z][a-z0-9+.-]*://[^\\s"\',;@]*:[^\\s"\',;@]*@[^\\s"\',;]+)';
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
    ASSIGNMENT_RE.test(text)
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
