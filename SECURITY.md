# Security policy

## Scope

This policy covers the `kimi-memory` plugin: every file under
`src/`, `hooks/`, `skills/`, `commands/`, `tests/`, plus the
`kimi.plugin.json` manifest. It does not cover the Kimi Code runtime,
the user's other plugins, or third-party models.

## Threat model

- **Asset**: the contents of every SQLite database under
  `$KIMI_CODE_HOME/kimi-memory/`. These are durable memory, working
  memory, working-log entries, conversation archives, ACL grants,
  tier/persona state, wiki pages, and codegraph edges.
- **Trusted**: the user, their Kimi Code runtime, the local filesystem.
- **Adversarial surface**: text the user pastes into chat or that an
  upstream model emits. The plugin must reject known credential shapes
  on every write path (content, title, tags, metadata, recursively).
- **Out of scope**: network adversaries, cross-process injection,
  untrusted code from sibling plugins.

## Reporting a vulnerability

Email security findings to the address listed in
`kimi.plugin.json`'s `developerName` lookup or open a private issue
on the GitHub repository. Please include:

1. Plugin version (`/plugins info kimi-memory`).
2. A minimal reproduction (MCP tool call, env var state, payload shape).
3. The disclosure timeline you need.

A response within 72 hours is the target. A CVE is issued for any
finding that meets the bar for public tracking.

## What this plugin does about secrets

- `src/persist/memories.js#saveMemory` runs `looksLikeSecret` on every
  string field of every `memory_save`/`memory_save_bulk`/
  `memory_update`/`memory_merge` call. Known shapes (OpenAI, Anthropic,
  GitHub, AWS, JWT, PEM, `key=…`, `Authorization: Bearer`) are refused
  with `KIMI_MEMORY_SECRET_DETECTED`.
- `src/extract.js#runAutoExtract` runs `redactSecrets` on the
  transcript before any LLM call, so credentials never reach the model
  provider.
- `src/util.js#safeErrorMessage` strips paths, IPs, and URLs from
  exception messages before they reach the agent context.
- `src/persist/memories.js#saveMemoryBulk` rolls back the entire
  transaction when one item fails the secret check, so a clean item
  cannot leak alongside a blocked one.

## What this plugin does NOT do

- It does not authenticate MCP callers. The ACL/visibility subsystem
  ships in the schema for future signed-token auth; until that lands,
  ACL rows are advisory, not enforced on the MCP server.
- It does not encrypt the SQLite files at rest. The databases live in
  the user's home directory under their existing OS-level protections.
- It does not transmit any memory or hook payload to a third party.
  The one outbound behaviour is the embedding model download from
  Hugging Face on first use (cached locally after); disable with
  `KIMI_MEMORY_EMBEDDINGS=off`.

## Cryptographic primitives in use

- SHA-256 prefix for project-key derivation (`src/project-key.js`). Not
  used for authentication; collision resistance is not the security
  primitive at play.
- SHA-256 hex digest for memory-id derivation (`src/util.js#hashId`).
  Same note.

## Path / input handling

- Project roots are canonicalized through `canonicalizeRoot` before
  hashing. Windows drive-letter case, UNC paths, and POSIX paths are
  each handled.
- All SQL is parameterized via `db.prepare(...).get/all/run(...)`. No
  user input reaches a query via string concatenation.
- Hook stdin is capped at 256 KB per the `readStdin` call in
  `src/hooks/run.js`.

## Dependency hygiene

`npm audit` is run on every CI push. The lockfile is committed; builds
are reproducible from `package-lock.json` only. Direct dependencies are
pinned to caret-ranges in `package.json`; the lockfile pins exact
versions.
