# Changelog

All notable changes to `kimi-memory` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). "Project-only" notes mean
the global DB is not touched; "Breaking" notes mean a stored row from a
prior version is rejected / migrated by the schema upgrade on first open.

## [Unreleased]

A second-pass audit of the 0.7.0 tree: eleven fixes, each with a failing
reproduction first and a regression test left behind. The two recurring
themes are inputs that reach a boundary unvalidated (the proxy, the DNS
name behind a base URL, the `offset` on a list call) and writes that are
not the single unit they claim to be (a save that clears a column it was
never asked to touch, two savepoints where one was needed).

### Security — `[__proto__]` in `config.toml` polluted `Object.prototype`

`parseToml` built its section tree by assigning through `node[key]` on
plain objects, so a `[__proto__]` header made `node` become
`Object.prototype` and every following line wrote an own property onto it
— process-wide, from a file on disk, on a path that runs on every
auto-extract pass. Chain-walking names (`__proto__`, `constructor`,
`prototype`) are now dropped and every write goes through
`Object.defineProperty`, which cannot reach a setter inherited from the
chain (`src/toml.js`, `tests/70-toml-prototype-pollution.test.js`).

### Security — the HTTP proxy dispatched around the tool's own schema

The tool registry handed the proxy the bare post-resolve callback, which
it called directly, so the SDK's `safeParseAsync` step never ran on an
HTTP body. Undeclared keys survived (a smuggled `scope: "global"` reached
`openScopeDb` on a tool whose schema has no `scope`, and wrote to the
cross-project store) and no declared cap applied (`memory_diagnostics
{limit: 1000000}` selected the whole log instead of the schema's 500).
The registry now stores `{ schema, fn }` — the raw shape wrapped in
`z.object()` so it is actually parseable — and dispatchTool parses every
body before dispatch. A rejected body is a 400, an unknown tool is still
a 404, and an `isError` tool-result is no longer returned as 200
(`src/mcp/lib/register-tool.js`, `src/proxy/server.js`,
`tests/71-proxy-schema-validation.test.js`).

The non-loopback destructive-tool set also gained the three tools it was
missing: `memory_promote_to_global` (moves rows out of the project DB),
`dream_apply_job` (soft-supersedes live sources) and `dreaming`
(`sub: "run", force: true` runs GC and defeats the debounce).

### Security — the base-URL guard judged one name, not the address

`guardLlmBaseUrl` is synchronous and offline by contract, so it only
refused literal private IPs and the bare name `localhost`: a NAME that
resolves to loopback (`127.0.0.1.nip.io`, `localtest.me`) passed, and so
did the CGNAT (`100.64/10`) and benchmarking (`198.18/15`) blocks, both
of which route to internal services on real networks. The two blocks are
now in the IPv4 table, and `resolveLlmTarget` resolves the host at the
single network boundary — refusing an unresolvable name, `localhost`, or
any address the name maps to that is loopback / private / link-local
(`src/extract.js`). That resolution is bounded at 2 s and an expiry is
refused like an NXDOMAIN, because it runs on the Stop path _before_ the
ingest-state write (`src/hooks/handlers/stop.js:100-105`) with the LLM leg
behind it already spending ~9 s of the 14 s ceiling: an unbounded
`getaddrinfo` — which has no timeout of its own — would cost the session
cursor rather than just the extraction.

### Fixed — a partial save cleared the session-focus marker

`saveMemory` derived `is_session_focus` from the caller's metadata and
wrote it unconditionally, so a patch that named no metadata
(`saveMemory(db, key, { id, priority })`) flipped an existing session-focus
row from 1 to 0 while its stored metadata still said
`{"session_focus":true}` — a row that contradicted itself, and the "where
we left off" line vanished from every later render. The column now uses
the same presence flag the neighbouring nullable columns use, keyed on
whether metadata was actually supplied (`src/persist/memories.js`).

### Fixed — `resetProject` could never succeed on a large project

The FTS sweep built one SQL placeholder per memory row, which hits
SQLite's 32766-bound-variable ceiling — the whole reset threw and rolled
back, even though the dry run succeeded, so `memory_reset_project
--confirm` (and the re-clone auto-reset command that tells the user to
run it) failed on exactly the projects it exists for. It is now a single
parameterised subquery (`src/persist/project.js`).

### Fixed — auto-prune could strand a memory with no search index

`deleteExpiredPair` used two `safeDelete` calls, i.e. two savepoints, so
the FTS row committed while its `memories` row was still pending. A
failure in the second delete (or a crash between them) left a live memory
that `memories_fts MATCH` recall and codegraph matching can never find
again. Both statements now share one savepoint, and the sweep runs before
the delete that empties its subquery (`src/auto-gc.js`).

### Fixed — the hook crashed instead of failing open on a closed pipe

A closed stdout pipe arrives asynchronously as an `'error'` event, so the
`try { process.stdout.write() } catch {}` around every write never saw it:
the event was unhandled, Node printed a stack and the process exited 1 —
the opposite of the file's own fail-open contract. The dispatcher now
installs a stream error listener at module scope
(`src/hooks/run.js`).

### Fixed — an overflowing embed timeout aborted every embed call

`KIMI_MEMORY_EMBED_TIMEOUT_MS` accepted any digit string, so a value above
2^31-1 overflowed Node's timer, warned, and fired after ~1 ms: every embed
call aborted with `embed_timeout` and recall silently degraded to
FTS-only. The value is clamped to the largest accepted delay
(`src/embedding.js`).

### Fixed — PEM block redaction was quadratic; an unbounded `offset`

`PEM_BLOCK_RE` used a lazy `[\s\S]*?` body, so every unclosed
`-----BEGIN … PRIVATE KEY-----` retried a match from its own position to
the end of the text. Measured through `redactSecrets` on a tail of
unclosed headers — the shape a key repeatedly echoed across a session
produces — 512 KB cost ~273 ms, 1.25 MB ~1724 ms and 2.5 MB ~6978 ms:
five times the input for twenty-five times the work, on a path reached
from a raw wire line with no size limit, under a 14 s Stop budget.

Capping the body does not fix it. A bounded lazy quantifier loses V8's
literal-lookahead fast path, so 512 KB measured 2814 ms _with_ the cap,
and a "no `-----END` in the text, skip the pass" pre-check only covers the
zero-marker case: one stray `-----END` at the end of the text still cost
3355 ms, and four spread through it 1292 ms (14.7 s and 13.5 s at 2.5 MB).

The block pass is now a linear `indexOf` scanner, not a regex: every
well-formed `-----END … PRIVATE KEY-----` footer is located once in a
forward pass and one forward-only pointer walks that list as the BEGIN
positions advance, so no position is ever rescanned for a second header.
The same three shapes now measure ~26 ms, ~24 ms and ~13 ms at 512 KB and
~125 ms at 2.5 MB — ~5x the work for 5x the input — with `looksLikeSecret`
(which runs on every write) at ~4 ms on 2.5 MB. The 64 KiB body cap stays
as defence in depth so one stray `BEGIN` cannot swallow a distant `END`,
and the scanner claims exactly the spans the capped regex claimed, so no
shape loses scrub coverage (`src/secrets.js`).

`validateOffset` accepted any finite non-negative number, so
`memory_list {offset: 1e30}` handed node:sqlite a value it rejects with a
raw `ERR_SQLITE_ERROR` datatype mismatch. It is now clamped to 1e9
(`src/validation.js`).

### Fixed — read-only opens re-ran the v12 reconcile as a write

The migration loop is re-entrant by design (the v12 pass re-derives
`is_session_focus` for rows an older build wrote without it), so every
open ran an unconditional `UPDATE memories SET is_session_focus = 1 …`.
An existence probe now short-circuits it, so a steady-state open — and
any read-only open — does no work (`src/persist/connection.js`).

### Fixed — `busy_timeout` was set after the version read

The connection raised `PRAGMA busy_timeout` after the schema-version read
and after the WAL switch, so the version read ran at SQLite's 0 ms
default: against a connection holding an exclusive lock it failed
immediately instead of waiting, and a hook turns that into a dropped
event. The pragma now runs first — it is per-connection state that
touches no file, so it neither mutates the DB nor weakens the version
gate (`src/persist/connection.js`). Measured: a contended version read
with `busy_timeout=1500` now returns after ~2.3 s where it failed in
~0 ms. The WAL switch itself is not covered by this — SQLite bypasses the
busy handler for a journal-mode change — so that half of the finding is
bounded but not eliminated.

### Fixed — a Dream job could claim `applied` while its proposals stayed `pending`

`applyDreamJob` skipped proposals below the confidence floor and then
wrote `status='applied'` unconditionally. The lifecycle path applies at
0.85 while the deterministic pass emitted its conclusion and
synthesizes-link proposals at 0.7, so every automatic apply committed
the merge (0.85) — rewriting a memory body and soft-superseding its
siblings — while the conclusion that body describes was never written,
and the pending rows could never be reached again because apply required
`status='ready'`. The deterministic proposals now share the merge's
confidence, so one floor selects the whole set, and an apply that leaves
anything pending settles the job as `partially_applied` (a new v17
status, added by rebuilding `dream_jobs` since SQLite cannot ALTER a
CHECK). A later explicit apply commits the remainder; running it twice
changes nothing. `dream_status`, the CLI, `dream_list_jobs`,
`dream_apply_job`, `dream_discard_job`, the enqueue guard and the
`last_dream_apply_at` readers all know the value
(`src/consolidate.js`, `src/dream.js`, `src/persist/connection.js`,
`tests/74-dream-job-lifecycle.test.js`).

### Fixed — re-generating proposals destroyed an already-`ready` job

`generateProposalsForJob` guarded only `applied` / `cancelled`, and the
proposal ids it writes are a pure function of (job id, kind, index), so a
second generation over a `ready` job collided on the primary key, the
savepoint unwound, and the job was marked `failed` — stranding every
proposal it had. `src/dreaming.js` triggers exactly that on any
`dreaming_run` that finds an existing ready job. Generation over a job
that already has proposals is now an idempotent no-op success that
leaves the rows byte-identical, a `failed` job is recoverable while
nothing on it was applied, and `runDreamPass` returns its summary —
it previously fell off the end of the function without a `return`, so
`passes.dream` was `undefined` on every successful run and a failed
generation was invisible. The same missing return had also masked the
`dreaming_run` handler ignoring its own validated `include`/`exclude`
filter; the filter is now honoured (`src/dream.js`, `src/dreaming.js`,
`src/mcp/handlers/dreaming.js`).

### Added — Dream lifecycle rows are swept once they are settled

`dream_jobs` / `dream_proposals` had no bound at all: a floor-limited
apply left its pending set on disk forever, and only a full project wipe
removed it. The auto-archive pass (same
`KIMI_MEMORY_AUTO_GC` / `KIMI_MEMORY_AUTO_ARCHIVE` gates as the other
archival sweeps) now deletes `applied` / `cancelled` / `failed` / `stale`
jobs older than 90 days together with their proposals. Jobs in `queued`,
`running`, `ready` or `partially_applied` are pending work and are never
touched, and `dream_enqueue` treats `partially_applied` as outstanding so
the queue stays at one job per project (`src/auto-gc.js`, `src/dream.js`).

## [0.7.0] — 2026-09-19

### Fixed — two earlier audit findings that never actually landed

The `2026-09-09` audit filed two MUST findings and marked both `landed`.
Neither fix was in the tree when `0.6.0` was pushed; the audit's
"tests pass" signal was green because the existing tests did not exercise
the paths it claimed to fix. Both are now fixed, each with a regression
test that fails without the fix (`tests/54-f1-f2-audit-fixes.test.js`).

- **`persona_promotions.from_tier` recorded the post-transition tier.**
  The audit read the previous tier _after_ the `UPDATE`; inside a
  transaction that sees the new value, so every auto-tier transition
  logged its destination as both `from_tier` and `to_tier`. The read now
  happens before the update (`src/auto-gc.js#transitionIds`).
- **The proxy accepted unbounded JSON nesting.** `readJson` handed the
  raw body straight to `JSON.parse`, so a deeply nested array could hit
  V8's call-stack limit. A `maxJsonDepth` guard now rejects bodies nested
  deeper than 64 levels with a 400 before parsing
  (`src/proxy/server.js`).

### Fixed — hook hard-timeout was a flat ceiling

The dispatcher enforced a single 8 s timeout for every event, while
`kimi.plugin.json` gives five events only 5 s each — so cleanup ran after
the runtime had already killed the process, and slower events were
aborted early. The ceiling is now per-event and always at least 1 s under
the manifest budget (`src/hooks/run.js`, `tests/55-hook-timeout.test.js`).

### Fixed — fresh databases paid two redundant table rebuilds

`SCHEMA_SQL` was missing `'conclusion'` and `'skill'` from the
`memories.type` CHECK, so the migrations that add those types never
short-circuited on a new database and rebuilt `memories` +
`memories_fts` twice. The CHECK now lists every type
(`src/persist/connection.js`).

### Fixed — `npm ci --ignore-scripts` left the ONNX runtime unbuilt

`onnxruntime-node` ships a prebuilt native binary unpacked by its
`postinstall`, which `--ignore-scripts` skips, so the first embed call
after a fresh install failed with a missing module. The launcher now
re-runs the install lifecycle for the two packages that need it
(`npm rebuild onnxruntime-node protobufjs`) while keeping the rest of the
tree scripts-off (`src/mcp/launcher.js`).

### Added — `KIMI_MEMORY_EMBEDDING_REVISION`, with an unpinned-model warning

The embedding model downloads from Hugging Face Hub on first use with no
hash check. Pinning the revision to a full commit SHA is the only
available integrity control, so the plugin now warns on stderr when the
revision is unpinned or is a movable ref (a branch or tag)
(`src/embedding.js#describeEmbeddingIntegrity`).

### Added — a warning when the secret-scan gate is off

`KIMI_MEMORY_SECRET_SCAN=off` bypasses the credential-shape gate
silently, and the README tells operators how to set it. It now logs a
one-shot stderr warning on first use (`src/persist/memories.js`).

### Security — credential detection, archive redaction, path containment

An audit found three gaps between what the docs promised and what the
code did. All three are fixed.

**The conversation archive stored credentials verbatim.**
`recordConversationEvent` (`src/persist/project.js`) wrote the raw wire
line into `conversation_events.payload` with no scan and no redaction, so
a secret pasted into chat was persisted and was returned by
`conversation_search` / `conversation_get` for the life of the archive.
Both `payload` and `summary` are now redacted before the row is written.
The payload is redacted value-by-value so it stays parseable JSON —
`src/session-focus.js` re-parses it to recover a missing summary.

**The credential patterns missed the most common real-world shapes.**
They are now in a leaf module, `src/secrets.js`, so the storage layer's
write gate no longer imports `extract.js` (and through it the embedding
model and the LLM client). Coverage added:

- JSON-quoted / TOML-quoted key names — `{"api_key": "…"}` did not match
  before, because the generic pattern required a whitespace/comma/semicolon
  boundary before the key name.
- `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, generic `*_TOKEN` and
  `*_SECRET` assignments, `password` / `pwd`.
- Connection strings carrying a `user:password@host` pair.
- `sk-proj-` (current OpenAI format), `sk_live_` / `sk_test_` (Stripe),
  `AIza…` (Google), `npm_…`, `hf_…`, `gh[pousr]_…`, `ASIA…`, and
  `Authorization: Basic …`.

The assignment value class also accepts `/ + = : @ . -`, so base64 blobs
and URLs are consumed whole instead of being matched only partway.

This mattered twice over: the same patterns were the only scrubber on the
auto-extract transcript before it is sent to the configured model, so a
missed shape was both persisted locally _and_ transmitted.

`memory_promote_to_global` and `acl_share_memory` now honour
`KIMI_MEMORY_SECRET_SCAN=off`. Their error messages had always advertised
that escape hatch while never reading the variable.

`kimi-memory import` now routes imported `working_memory` slots through
`setWorkingMemory`, so they pass the same gate as the live MCP tool. The
direct `INSERT` it used before bypassed the scan entirely.

**Path traversal in `conversation_ingest`.** `locateSessionArchive`
(`src/wire.js`) joined a caller-supplied `session_id` / `work_dir_key`
straight into a filesystem path, so a `session_id` of `../../..` read a
`wire.jsonl` outside the data root and ingested it. Both values are now
validated as single path segments and every candidate is confirmed to
resolve underneath `<home>/sessions`. The unused and similarly unsafe
`findSessionDir` was removed.

### Security — the diagnostics log is now actually scrubbed

`README.md` promised that absolute paths, host names and URLs are removed
from `_diagnostics/hooks.log`. They were not: every `log*Error` helper
wrote `error.message` and the full `error.stack` verbatim, and
`logHookDiag` wrote an arbitrary context object. All of it — message,
stack, and every string in the context, recursively — now passes through
`sanitizeText()` (path/URL/host substitution plus credential redaction)
before it lands on disk. The log persists for 90 days.

### Fixed — `shouldRetry` classifiers never saw the error

`withRetry` hands `shouldRetry` a `{ error } | { value }` state wrapper.
All three wrappers in `src/retry.js` read `.code` / `.message` straight
off that wrapper, so each classification fell through to its default
branch:

- `withLlmRetry` **never retried anything**, including the empty-reply
  case the retry exists for. A single provider flap lost the whole
  auto-extract pass. It now retries an empty reply and transient
  transport failures, and still does not retry auth errors. Its attempt
  budget was cut to 2 attempts with a 500 ms base delay: it runs inside
  the Stop hook, which `kimi.plugin.json` caps at 15 s, and each attempt
  can burn 4 s in `extract.js`.
- `withAutoExtractRetry` **always** retried, including on the auth and
  missing-config errors it explicitly classified as permanent.
- `withDbRetry` never retried a busy lock, and would have retried a
  resolved `null`.

### Fixed — edge-kind vocabulary had drifted across three copies

The MCP validator (`src/validation.js`) accepted five edge kinds; the
graph layer (`src/persist/edges.js`) and the SQL `CHECK` constraint
accepted eight. `validateEdgeKind` therefore rejected `imports`, `calls`
and `defines` — kinds the database was happy to store. The vocabulary now
lives in `src/edge-kinds.js`, and the `CHECK` constraint is generated from
it so the schema cannot disagree with the validator.

### Changed — visibility and tier vocabulary consolidated

Visibility was declared in four places (`src/acl.js`, `src/persist/share.js`,
and six hardcoded Zod enums in `src/mcp/tool-defs.js`). It now lives in
`src/vocabulary.js`, alongside the tier ladder and the ACL principal
kinds.

### Changed — the `memories.js` ↔ `share.js` import cycle is gone

`persist/memories.js` imported its visibility/tier vocabulary from
`persist/share.js`, which imported `rowToMemory` / `getMemory` back from
`persist/memories.js`. Both sides now read the vocabulary from
`src/vocabulary.js`, so the two modules load and test independently.

### Changed — dead modules removed, one wired up

- `src/config.js` — imported only by its own tests. Its
  `validateConfig` also discarded every top-level section except
  `[kimi-memory]`, so adopting it would have broken model resolution.
- `src/concurrency.js` — its write counters had no production consumer.
  `isSqliteBusyError` moved to `src/retry.js` and replaced the hand-inlined
  duplicate inside `withDbRetry`.
- `src/hooks/embed-retry.js` — was dead despite its header claiming
  otherwise; nothing ever retried a failed embedding even though
  `saveMemory` records `last_embed_error`. It is now called from
  `handleSessionStart`, and the header names its real caller.

### Changed — internal structure

- `src/hooks/handlers/lib/pipeline.js` was 1,071 lines with 34 exports
  spanning payload parsing, recall ranking, rendering, auto-GC, Stop
  orchestration, Dream and auto-extract. It is now 57 lines of
  orchestration plus `payload.js`, `recall.js`, `render.js`,
  `dream-hooks.js` and `stop.js`. The set of names it exports is
  unchanged.
- The CLI's per-scope "does the DB exist / open / close" block was copied
  into four subcommands and had drifted. `eachScopeDb` in `src/cli/lib.js`
  is now the single implementation; `list`, `get` and `export` use it.
  `status` and `acl` build different output shapes and were left alone.
- Three hook handlers re-derived the storage layout instead of calling
  `projectDbPath` / `globalDbPath`. `session-start.js` shadowed the
  imported `projectDbPath` name with a local const; the shadow is gone.
- `truncate`, `firstContentLine` and `sliceCodePointSafe` each existed in
  two byte-identical copies. All three now live in `src/util.js`.
- Unused `findSessionDir` removed from `src/wire.js`.

### Fixed — a documented slash command did not exist

`/kimi-memory:reset-project` was advertised in `README.md` (twice) and in
`kimi.plugin.json`'s `longDescription`, but no such command registered.
Per the plugin docs a command's frontmatter `name:` overrides its
filename, and `commands/reset-project.md` declares `name: reset_project`
— so the invocable id was `/kimi-memory:reset_project`, and the
hyphenated form in the docs was unreachable.

The `README.md` and manifest references are corrected. `commands/` now
also holds `list_memories.md` and `reset_project.md` rather than
`list-memories.md` / `reset-project.md`, so the filename and the
registered name agree: the underscore spelling is what the paired
Skills (`/reset_project`, `/list_memories`) use, and leaving the
filename hyphenated meant a dropped frontmatter field would have
silently renamed the command.

### Changed — dead imports removed

`import` bindings that were never referenced are gone from 25 files
(12 under `src/`, 13 under `tests/`). This is not purely cosmetic in one
direction: an unused `import` still executes the target module, so the
cleanup was re-verified against the full end-to-end path rather than
trusted to the unit suite. `scripts/check-syntax.js`'s header comment
claimed the old hand-maintained check list referenced `src/search.js`
"that no longer exists"; `src/search.js` does exist and is imported by
`src/persist/search.js`, so the comment now names modules that are
actually gone.

### Tests

- `tests/49-secret-coverage.test.js` — every credential shape is asserted
  to be detected, to be _removed_ by redaction, to not re-detect, and to
  be idempotent. The "removed" assertion is the important one: an earlier
  revision of `redactSecrets` appended the `[REDACTED_*]` token while
  leaving the secret bytes in place, and both the "token appears" and
  "no longer re-detects" checks passed against it.
- `tests/50-vocabulary-and-path-guards.test.js` — traversal rejection,
  legitimate resolution, and agreement between the edge-kind validator,
  the SQL `CHECK` constraint and the tool schemas.
- `tests/51-diagnostics-scrub.test.js`, `tests/52-retry-classifiers.test.js`.
- `tests/53-command-registration.test.js` — the three places a slash
  command's name is written down (the file under `commands/`, its
  frontmatter `name:`, and every `/kimi-memory:<x>` reference in the
  docs) must agree, and every reference must resolve to a registered
  command. Written after the `reset-project` defect above; reverting
  that one manifest string fails the test by name.
- `tests/06-manifest.test.js` now walks `commands/*.md` instead of
  listing four of them, so a renamed or added command cannot fall out of
  coverage — the hardcoded list is exactly what let the stale
  `list-memories.md` reference survive.
- `tests/_helpers.js` — `StdioMcp` had no timeout and swallowed child
  errors, so a missing dependency made 16 files hang indefinitely. It now
  fails fast with the child's stderr tail. Verified with `node_modules`
  moved aside: the run now fails in ~270 ms instead of hanging.
- `tests/06-manifest.test.js` derives the tool counts from `TOOL_DEFS`
  instead of hardcoding them. Its old regex excluded the `dreaming` tool,
  which is why it passed while the advertised count was wrong.
- Corrected three tests whose names overstated what they asserted
  (`tests/28-pipeline-status.test.js`, `tests/38-audit-fixes-coverage.test.js`).
  The symlink path-escape test now reports an explicit skip on Windows
  instead of silently returning green.
- Renamed `tests/22-reset-project` → `22b-` and `tests/40-consolidate-relax`
  → `40b-` to remove the duplicate file numbers.

### Docs

- `AGENTS.md` is new, and is no longer in `.gitignore`: `README.md`,
  `CHANGELOG.md` and `skills/kimi-memory/references/tools.md` had all
  been pointing readers at a file that did not ship.
- Corrected the tool count (52 total, 37 always-on, 15 gated), the hook
  count (nine, not eight), the slash-command list, `commands/promote.md`
  (the MCP tool has no dry run — only the CLI does) and
  `commands/dreaming.md` (it documented three tools that do not exist;
  they are operation names).
- Replaced drift-prone `file.js:NNN` citations in this file with symbol
  names, and updated the line counts and the `README.md` file list.

### Changed — `detectProjectMetadata` now regex-scans scripts for stack tools

The auto-extracted "Project build/stack details" memory used to label any
Node-only repo (no `packageManager` field, no `typescript` dep) as
`Stack: unknown` — useless for the agent. `src/extract.js` now runs a
regex scan over every script body in `package.json` against a fixed
table of well-known tools:

- Test runners: `node --test` → `node (test runner)`, `jest`, `vitest`,
  `mocha`, `ava`, `tap`
- TypeScript variants: `tsc` → `typescript (compiler)`, `tsx`, `ts-node`
- Bundlers: `vite`, `webpack`, `rollup`, `esbuild`, `parcel`, `turbo`,
  `nx`
- Linters / formatters: `eslint`, `prettier`

A single tag is emitted per tool even when multiple scripts reference it
(`lint`, `lint:fix`, `pretest` can all reference `eslint` without
duplicating the tag in the surfaced memory). Script-invoked tooling
(`npx jest`, `pnpm dlx eslint`) is matched by the same regex — the tool
name appears anywhere in the script body.

The devDependency-based `typescript` tag is preserved alongside the new
`typescript (compiler)` regex tag — they are distinct facts (dep declared
vs. compiler invoked) and may both apply.

### Fixed — `<system-reminder>` blocks no longer leak into durable memory

`extractSummary` (`src/wire.js`) now strips agent-injected
`<system-reminder>...</system-reminder>` blocks from extracted user-prompt
text before storing it in `conversation_events.summary`. The reminder text
is tooling guidance from the host runtime (todo list reminders, hook
results, session reminders); it is not the user's own words and was
silently contaminating focus rows, auto-extract input, and recall hits.

The regex matches both complete blocks (`<system-reminder>...</system-reminder>`)
and unclosed trailing fragments (rare but observed). When the entire
payload was a reminder block, `extractSummary` returns `null` so the
caller treats the row as text-empty. Fix 2's `readSessionUserPrompts`
then drops it via the empty-after-trim filter, and `captureSessionFocus`
reports `no_user_prompt_text` instead of writing a contaminated row.

### Added — `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL` env var documented

The cross-project opt-out flag for the auto-extract dispatcher (Fix 1)
is now documented in the README's Configuration table alongside the
other env vars.

### Added — `memory_promote_to_global` MCP tool

New always-on MCP tool (`src/mcp/handlers/share.js`, registered in
`src/server.js`, defined in `src/mcp/tool-defs.js`). Inputs: `cwd` +
`memory_ids` (1-500 ids). Behaviour: each id is validated, duplicates are
collapsed, and the persist-layer `promoteMemoryToGlobal` runs the move
(see CHANGELOG entry above). The handler defensively re-queries the
global DB after the move and surfaces any row that did not land as a
`skipped` entry with reason `global_write_missing`.

The tool is intentionally separate from `acl_share_memory` (which
targets the deprecated `_shared` pool and is gated behind
`KIMI_MEMORY_LEGACY_SUBSYSTEMS`). `memory_promote_to_global` targets the
always-on `_global` store, never the ACL pool. The slash command
`commands/promote.md` walks through the dry-run + apply flow.

`tests/06-manifest.test.js` and `kimi.plugin.json` longDescription both
bump from 50 → 52 tools to keep the count honest.

### Added — `promoteMemoryToGlobal` persist function + `promote-to-global` CLI/slash command

The new persist-layer function `promoteMemoryToGlobal(db, projectKey, ids, { kimiHomeDir })` (in `src/persist/share.js`) moves one or more rows from the project DB into the cross-project `_global/memory.sqlite` store. The source row is removed; the global row keeps the same id so callers holding the id don't break. The move is a two-phase commit with compensation (writes hit the global DB first, then the source DB deletes; if the source-DB step fails, the global writes are undone).

Defence-in-depth: secret-shape re-scan (`looksLikeSecret`) runs on every candidate before the move. Secret-shaped rows land in the `skipped` list with `reason: 'secret_detected'` rather than being moved; the source row stays in the project DB. Idempotent: re-running with the same ids returns `skipped: [{id, reason: 'not_found'}]` for the rows that already moved.

CLI surface (`src/cli-cmd/promote-to-global.js`, wired into `src/cli.js`): dry run by default, `--apply` to perform the move, `--memory-id` repeatable, `--memory-ids <csv>` shorthand, `--json` output. Slash command at `commands/promote.md`.

### Changed — Auto-extract routes global candidates to the cross-project store

The Stop-hook auto-extract (`runAutoExtract` in `src/extract.js`) previously saved every
candidate to the active project's DB. The dispatcher now branches on a new
optional `scope` field the model emits per candidate:

- `scope: "global"` — user preferences, environment facts, reusable
  procedures. Routes to `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`
  and becomes visible from any project.
- `scope: "project"` (default if omitted) — project conventions, current
  state, build/stack facts. Continues to land in the per-project DB.

The classification rule is added to `EXTRACT_SYSTEM_PROMPT`. Parsing
(`parseExtractionResponse` in `src/extract.js`) accepts the new
optional `scope` field; unknown values fall back to `project` rather than
rejecting the whole batch. Dedup (`dedupeCandidates` in
`src/extract.js`) walks the per-scope corpus so a "user prefers
dark mode" candidate dedups against the global DB, not the project DB.

Operators who want to freeze the cross-project store without disabling
the per-project pass can set `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL=off`; the
dispatcher reroutes every global candidate to project scope. The result
object gains a `global_saved` count so the hook log records what landed
where.

### Changed — Permissive session-focus: payload fallback + dedicated empty-text skip

`readSessionUserPrompts` (`src/session-focus.js`) used to drop every
user-role event whose `summary` was null or empty, which silently skipped
sessions where the wire-ingest LLM call had failed or where the user prompt
was a tool-only command with no text body. The new shape:

- SQL no longer filters by `summary != ''`; all user-role rows are read.
- Each row's `prompt` is `summary` first; if summary is empty, the row
  falls back to `extractSummary(JSON.parse(payload))` against the stored
  raw payload — the same extractor `wire.js` uses at ingest time.
- Rows whose final prompt is empty after trim are dropped post-fetch so
  the caller still sees a clean oldest→newest list.

`captureSessionFocus` (`src/session-focus.js`) now splits the old
`below_threshold` skip into two unambiguous reasons:

- `below_threshold` — zero user-role events in the session.
- `no_user_prompt_text` — user events exist but none carry any text body.

Both are visible in the hook diagnostic log (`focus=skip:<reason>`).

### Fixed — Missing imports in `src/hooks/handlers/` broke every hook spawn

Two files in the hook split were missing imports that were always
consumed at runtime, so every hook invocation that reached the
affected call site threw `ReferenceError`. The dispatcher caught
the error and wrote `[kimi-memory] hook <EVENT> failed: <name> is
not defined` to stdout instead of the real handler output, which
failed 10 tests across `tests/04-hooks.test.js`,
`tests/15-hook-stress.test.js`, and `tests/23-session-focus.test.js`.

- `src/hooks/handlers/lib/pipeline.js` — `logHookDiag` (the
  underlying sink the helper `logDiag` writes through) was used on
  line 102 but never imported. Every Stop / SessionEnd / PreCompact
  / Interrupt / StopFailure hook crashed the first time the
  shared `logDiag` was invoked from a deeper handler.
- `src/hooks/handlers/session-start.js` — the import block from
  `./_helpers.js` was missing `readLatestSessionFocus`,
  `buildSessionFocusLine`, `buildSessionThread`, `firstContentLine`,
  `buildWorkingMemoryPreview`, and `buildStaleMemoryLine`, and the
  cross-module imports `runConsolidate` (from `../../consolidate.js`)
  and `buildDreamStatus` (from `../../dream.js`) were absent. Every
  SessionStart hook crashed at the first `runConsolidate` call and
  emitted no stdout, so all of `tests/04-hooks.test.js`'s
  SessionStart assertions and the bounded-preview cases in
  `tests/15-hook-stress.test.js` failed.

After the fix, `npm test` reports 416/416 pass (was 405/416 with
10 failures), and `npx prettier --check .` is clean.

### Fixed — UserPromptSubmit hook output is now a single line

The hook's human-readable `<hook_result>` message used to lead every
prompt with three lines of metadata the user did not ask for:

```
[kimi-memory] event=UserPromptSubmit project_key=ffef2a61… pmem.active=5 gmem.active=0 wm=0 conv=3 events=682 ingest=ok:7 extract=saved:2/dup:0 work_log=updated focus=saved dream=applied:1 recall project:5 global:0 cwd=…
Recalled 5 memories. (5 project.)  [working: 2, episodic: 1, procedural: 1, semantic: 1]
[focus] "Last focus: <system-reminder> The previous turn was interrupted…" (working) — Most recent user requests in this session (oldest → newest):
```

It is now exactly one line:

```
[kimi-memory] Recalled 5 memories. (5 project.)  [working: 2, episodic: 1, procedural: 1, semantic: 1]
```

Counts, ingest results, and the verbose status line are still produced
internally — they now flow through the dispatcher's diagnostic log
(`$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log`) instead of stdout,
so they remain greppable for debugging without cluttering the chat. The
per-memory recall hits and the `[focus]` line both still reach the model
through `hookSpecificOutput.additionalContext`, so the agent can still
open with "Picking up from: …" or "From your saved notes: …" — the user
just no longer sees any of that metadata inline.

- `src/hooks/handlers/user-prompt-submit.js` — message is now exactly
  `[kimi-memory] <recall.summary>`. The status line, focus line, WM
  preview, stale-memory line, and advisor line all moved to the
  diagnostic log; the focus line is also appended to `additionalContext`
  so the agent still sees it.
- `tests/04-hooks.test.js` — asserts the message is the single
  `[kimi-memory] <recall summary>` line, no newline, no verbose fields.
- `tests/23-session-focus.test.js` — focus line is now asserted inside
  `additionalContext`, not the chat-facing message.
- `skills/kimi-memory/SKILL.md`,
  `skills/kimi-memory/references/recall-acknowledgement.md` — updated
  to describe the new minimal output format.

### Changed — Recall summary surfaces the candidate-pool denominator

The `UserPromptSubmit` summary line used to read `Recalled N memories.
(N project, N global.) [semantic: …]` with no context for how
representative `N` was. An 8-memory project always returned 8 hits
even when only 1 was relevant, and the user had no way to tell from
the line alone. The line now includes the pool denominator and reads
`Recalled N memories of M.` where `M` is the active-memory count
across project + global.

- `Recalled 1 memory of 1.` (1 global.) — tiny pool, single hit.
- `Recalled 5 memories of 24.` (4 project, 1 global.) [semantic: 2, procedural: 1] — partial-coverage recall.
- `Recalled N memories.` (no `of M`) — fresh install, neither DB exists, so `poolSize === 0` and the denominator is suppressed.
- `No recall hits.` — unchanged.

`src/hooks/handlers/lib/pipeline.js` — `buildRecallSummary` reads the
active count from both DBs via `memoryCounts(...).active` and adds
`of ${poolSize}` to the summary template when `poolSize > 0`.
`tests/04-hooks.test.js` regex updated to accept the optional `of M`
segment; `tests/23-session-focus.test.js` regex was already tolerant.
Skill doc strings updated (`skills/kimi-memory/SKILL.md:72`,
`skills/kimi-memory/references/recall-acknowledgement.md:3,30`).

### Fixed — Recall accuracy: pool-aware cap + score-gap elbow

The recall surface had a hard-coded `RECALL_CANDIDATE_LIMIT = 8` per
DB, so a project with 8 saved memories surfaced 8 hits on every prompt
even when only 1 was actually relevant. Two new tunables in
`src/hooks/handlers/lib/constants.js` make the surface adaptive:

- `RECALL_BASE_LIMIT = 8` — hard ceiling per DB (the previous default).
- `RECALL_MIN_HITS = 3` — floor on the per-DB limit, so a 1-memory project still gets surfaced.
- `RECALL_GAP_FACTOR = 0.4` — score-gap elbow: after per-type selection, drop any hit whose RRF score is below `topScore * 0.4`.

The per-DB limit is now `max(RECALL_MIN_HITS, min(RECALL_BASE_LIMIT, ceil(active / 2)))`, so a 12-memory project caps at 6 hits per DB and a 50-memory project still caps at 8. The cap is the SQL `limit`, so the padding rows are not even read off disk. The gap filter runs after per-type selection so the user keeps a balanced 1-per-type preview; only the padding rows get trimmed.

- `src/hooks/handlers/lib/pipeline.js` — `buildRecallSummary` rewritten with pool-aware cap + score-gap filter.
- `src/hooks/handlers/lib/constants.js` — three new tunables documented with their thresholds.
- `tests/45-recall-gap-filter.test.js` — new file, 6 tests covering constants, pool-aware cap (3, 8, 12, 50 memories), no-DB edge case, and the gap-filter scenario.

Set `KIMI_MEMORY_RECALL_GAP_FACTOR=0` to disable the gap filter
(escape hatch for tests + advanced users who want the pre-filter surface).

The hook was emitting both a plain-text block (`emitLines(...)`) AND a
trailing JSON envelope on stdout. Kimi's hook runner
(`packages/agent-core/src/session/hooks/runner.ts`) only recognises the
top-level JSON field `message` — the previous `systemMessage` field is
a Codex/Claude Code convention Kimi does not parse. Because no `message`
was present, Kimi fell back to dumping the raw stdout verbatim, which
included the entire JSON envelope, producing a doubled, noisy
`<hook_result>` block in the user's chat.

- `src/hooks/handlers/user-prompt-submit.js` — stdout is now a single
  JSON envelope with `message` (Kimi's protocol field name) carrying the
  human-readable lines and `hookSpecificOutput.additionalContext`
  carrying the per-memory recall list. The plain-text `emitLines`
  duplicate is gone.
- `tests/04-hooks.test.js`, `tests/13-recall-per-type.test.js`,
  `tests/23-session-focus.test.js` — updated to parse the new `message`
  field.
- `skills/kimi-memory/references/recall-acknowledgement.md` — corrected
  the field-name reference (`message`, not `systemMessage`).

### Added — Subsystem deprecation gate

Four subsystems shipped in v0.5.0 (ACL/visibility, tier/persona, wiki,
codegraph) are deprecated: they are ported from `TencentDB-Agent-Memory`
but have no authenticated MCP caller and no agent-workflow integration.
A new `KIMI_MEMORY_LEGACY_SUBSYSTEMS` env var hides the 20 corresponding
MCP tools (ACL: 5, tier: 4, wiki: 5, codegraph: 6) and skips the
auto-tier promotion + `persona_promotions` archive sweeps when set to
`off`. The schema columns + tables remain in place so flipping the env
var back on requires no migration. Removal is planned for the next
major version.

- `src/server.js` — the 20 legacy tool registrations are now wrapped in
  `if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS !== 'off') { ... }`.
- `src/auto-gc.js` — `runAutoTier` and the `persona_promotions`
  archive in `runAutoArchive` honour the same gate.
- `README.md`, `AGENTS.md`, `skills/kimi-memory/references/tools.md`
  document the new env var.
- `kimi.plugin.json` `interface.longDescription` now lists the 20
  deprecated tools with a `[deprecated]` marker.

### Added — Hook split

`src/hooks/run.js` (1,772 lines, 8 events) is split into a slim
dispatcher plus per-event modules under `src/hooks/handlers/`:

```
src/hooks/run.js                          # dispatcher (146 lines)
src/hooks/handlers/_helpers.js            # shared utils + lifecycle helpers
src/hooks/handlers/session-start.js
src/hooks/handlers/user-prompt-submit.js
src/hooks/handlers/stop.js                # Stop + SessionEnd + PreCompact + Interrupt + StopFailure + autoExtract
src/hooks/handlers/post-tool-use.js
src/hooks/handlers/post-tool-use-failure.js
src/hooks/handlers/lib/                   # per-event helpers (constants, format, pipeline)
```

The public helper exports (`buildRecallQuery`, `diversifyHitsByType`,
`readRecentFilePaths`, `buildSessionThread`, `formatConsolidateSegment`)
are re-exported from `run.js` for backward compatibility with any
consumer that previously imported them from the dispatcher.

### Added — Progressive disclosure for the `kimi-memory` skill

`skills/kimi-memory/SKILL.md` was 25 KB (one monolithic file). It is
now a ~10 KB routing/hygiene/types/flow file with deeper material in
four reference files:

- `skills/kimi-memory/references/tools.md` — full MCP tool catalog.
- `skills/kimi-memory/references/recall-acknowledgement.md` — how to
  acknowledge `[recall]`, `[focus]`, `[thread]`, `[tool-recall]`
  segments on the hook status line.
- `skills/kimi-memory/references/active-memory.md` — v9+ behaviour:
  continuous retrieval, mid-turn recall, decay, cross-session thread,
  background consolidation, auto-GC.
- `skills/kimi-memory/references/decay-contract.md` — the Ebbinghaus
  decay formula and the migration that introduced the columns.

`kimi.plugin.json`'s `skillInstructions` is trimmed to match.

### Added — Project docs

`AGENTS.md`, `SECURITY.md`, and `CONTRIBUTING.md` now live at the
repository root. They were missing in v0.6.0.

### Compatibility notes

- `KIMI_MEMORY_LEGACY_SUBSYSTEMS` defaults to `on` — the 20 legacy
  tools remain registered by default, so existing automation that
  calls them keeps working. Opt-out is explicit (`=off`).
- The hook split is internal: handler function names + behaviour are
  unchanged. The split itself was incomplete at the time of writing
  (see the `[Unreleased]` "Missing imports in `src/hooks/handlers/`"
  entry — 10 hook tests were silently failing until the missing
  `logHookDiag` and `_helpers.js` imports were added).
- The skill split is byte-equivalent for content; only the layout
  changed. References are loaded on demand by the agent.

## [0.6.0] — 2026-08-19

### Added — Staged Dream consolidation (Phase 1)

Phase 1 of the Dream subsystem replaces the inline, fire-and-forget
"dream pass" with a durable, operator-controlled job pipeline.

- New module `src/dream.js` (848 lines) owns the Dream job state
  machine: `queued → running → ready → applied` with
  `stale / failed / cancelled` terminal branches.
- A partial unique index (`idx_dream_jobs_active`) enforces
  "one running job per project" at the SQL layer, so concurrent
  enqueues are a no-op rather than a crash.
- Schema migration adds two tables:
  `dream_jobs(project_key, status, enqueued_at, ...)` and
  `dream_proposals(job_id, source_memory_ids, conclusion_kind, ...)`.
- Apply path runs every proposed write inside a single `SAVEPOINT`
  so a mid-flight crash leaves the project DB untouched. Each
  proposal is re-validated against the live rows
  (`status='active'`, source `checksum` unchanged, ids intact);
  drifted sources are marked `stale` and skipped.
- Hook layer (`src/hooks/run.js`) enqueues a Dream job from
  `Stop` and `SessionEnd` once the activity threshold + debounce
  window both allow. `SessionStart` opportunistically drives one
  ready → applied cycle inside its 8s budget.
- Project scope only — no global-memory Dream surface in Phase 1.
  The global store stays curated by the user via MCP / `memory_save`.

### Added — 9 new MCP tools

| Tool                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `dream_status`             | Compact `{label, counts}` for the active project.                   |
| `dream_enqueue`            | Idempotently enqueue a Dream job (no-op if one is queued/ready).    |
| `dream_generate_proposals` | Run clustering inside a single `SAVEPOINT` and write proposal rows. |
| `dream_apply_job`          | Validate + apply every non-stale proposal in one `SAVEPOINT`.       |
| `dream_discard_job`        | Mark a `queued / ready` job `cancelled`; reject pending proposals.  |
| `dream_list_jobs`          | Paginated list of jobs by status.                                   |
| `dream_get_job`            | Single job by id.                                                   |
| `dream_list_proposals`     | Paginated list of proposals by job + status.                        |
| `dream_get_proposal`       | Single proposal by id.                                              |

Total tool count: **46 → 55**, then **55 → 50** when the wiki subgroup
was retired in the next major (the deprecated ACL / tier / codegraph
tools remain for backward compat, gated behind
`KIMI_MEMORY_LEGACY_SUBSYSTEMS=off`).

### Added — env-var / hook opt-outs

| Variable            | Default | Effect                                                                     |
| ------------------- | ------- | -------------------------------------------------------------------------- |
| `KIMI_MEMORY_DREAM` | `on`    | `off` skips both `Stop/SessionEnd` enqueue and `dream_generate_proposals`. |

### Tests

- `tests/39-dream.test.js` (583 lines, 12 cases) covers schema
  migration idempotency, per-project isolation, idempotent enqueue,
  proposal-mode non-mutation, apply path with concurrent drift
  detection, stale-source skip, discard, status shape, debounce
  tracking, source-checksum stability, legacy `runConsolidate`
  compatibility, env opt-out, and crash recovery.
- `tests/40-audit-fixes-batch2.test.js` (8 cases) pins the
  `safeErrorMessage` path-redaction audit fixes so the
  prettier reformat of `src/util.js` cannot silently regress.

### Docs / house-keeping

- README rewritten: now lists 55 tools and the new Dream row;
  env-vars table covers `KIMI_MEMORY_DREAM`.
- `kimi.plugin.json` tool count + Dream tool names added to the
  `longDescription`.
- Doc-only files removed: `ARCHITECTURE.md`, `CHANGELOG.md`
  (this file replaces it), `CONTRIBUTING.md`, `CONVENTIONS.md`,
  `IMPROVEMENTS.md`, `PROJECT.md`, `shipgate-report.md`, and the
  per-module `MODULE_BRIEF.md` files.
- New research note: `research/claude-dreams-idle-consolidation-2026-08-18.md`.

### Compatibility notes

- Users on `0.5.1` upgrading in place: the schema migration is
  additive (only adds `dream_*` tables), so existing project +
  global DBs open cleanly. No data migration required.
- Users who had set `KIMI_MEMORY_CONSOLIDATE=off` to disable the
  inline dream pass now have a second knob
  (`KIMI_MEMORY_DREAM=off`) for the staged pipeline. The two are
  independent — leaving `KIMI_MEMORY_DREAM=on` will still create
  Dream jobs even when `KIMI_MEMORY_CONSOLIDATE=off`.

## [0.5.1] — 2026-08-16

### Fixed — audit-cycle cleanup

- `src/lifecycle.js` removed; responsibilities moved into
  `src/hooks/run.js`.
- `src/performance.js` removed; responsibilities moved into
  per-pass callers.
- 21-comprehensive-improvements.test.js trimmed: redundant cases
  moved to the focused `tests/37-share-move-metadata.test.js` and
  `tests/38-audit-fixes-coverage.test.js` files.

## [0.5.0] — 2026-08-10

### Added — Phase-v10 stack

- ACL + visibility layer (`acl_grant`, `acl_revoke`, `acl_list`,
  `acl_share_memory`, `acl_resolve_principal`).
- Tier + persona layer (`memory_set_tier`, `memory_promote`,
  `memory_demote`, `memory_tier_history`).
- LLM-Wiki (`wiki_upsert_page`, `wiki_get_page`, `wiki_traverse`,
  `wiki_backlinks`, `wiki_resolve`).
- Codegraph (`codegraph_extract`, `codegraph_build_edges`,
  `codegraph_query_symbol`, `codegraph_impact_path`,
  `codegraph_callers`, `codegraph_callees`).
- Ebbinghaus decay + reinforcement on recall hits.
- Background consolidation + auto-merge on tight clusters.

See `git log` for the full pre-0.5.0 history.
