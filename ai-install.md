# ai-install.md

Agent-facing install procedure for the **kimi-memory** plugin (managed-copy
id `project-memory`). Run every step end-to-end before reporting success;
partial installs leave the Skill and MCP missing. Do not ask the human to
click anything — type the slash commands into the Kimi chat input yourself.

The plugin source is this directory. Its `name` in the manifest is
`kimi-memory`; Kimi stores the install under `$KIMI_CODE_HOME/plugins/managed/project-memory/`.

## 0. Scope of this doc

Covers installs of this plugin only — **into** Kimi Code on the user's
machine. Three install sources are handled:

- Local checkout (the common dev case).
- GitHub URL (no clone required; Kimi pulls the source itself).
- A previously-managed copy that's drifted from the source.

If the user is not on the machine holding Kimi, do not invent a remote
procedure — every step below assumes local `node` + local `kimi`.

## 1. Pre-flight

Collect these before doing anything; every later step depends on them.

1. `kimi --version` prints a version. If not, Kimi Code is missing on this
   host — stop and tell the user.
2. `node -v` is `>=24.0.0`. The plugin uses `node:sqlite`, which Node 24
   ships built-in; older majors fail at MCP startup with an unhelpful
   `ERR_UNKNOWN_BUILTIN` and the failure surfaces only after reload.
3. Resolve `$KIMI_CODE_HOME`. Default `~/.kimi-code/`. If `KIMI_CODE_HOME`
   is exported, trust that and do not probe the default; the two roots
   have independent `installed.json` files.

If any check fails, stop. There is no install to do on a host without
`kimi` and a Node 24 runtime.

## 2. Locate the source

You need a directory containing both `kimi.plugin.json` and `package.json`.
Three forms are accepted by `/plugins install`:

| Form | Example | When |
|---|---|---|
| Local directory | `/abs/path/to/project-memory` | Working tree, branch checkout. |
| GitHub repo | `https://github.com/<owner>/<repo>` | No clone — Kimi pulls source itself. Falls back to default branch if no release. |
| Pinned ref | `…/tree/<ref>`, `…/releases/tag/<tag>`, `…/commit/<sha>` | When the user pinned a version. |

For local installs, resolve to an **absolute** path. Kimi rejects relative
paths and silently skips the install if the resolved manifest is missing.

## 3. Install dependencies

Inside the source directory:

```bash
npm install
```

This is mandatory even when installing from a GitHub URL: Kimi copies
the source into `plugins/managed/project-memory/` but does not run
`npm install` for you. Without `node_modules/`, the MCP server fails to
start with `Cannot find module '@modelcontextprotocol/sdk'`, which
surfaces only after `/reload` and looks like a manifest bug.

## 4. Self-check

Run unless these have already passed in the same session:

```bash
npm run check   # node --check on every source file
npm test        # node --test tests/*.test.js — full persist + MCP + manifest suite
```

Both must exit 0. A failing `check` means the manifest or schema drifted
out of sync with the runtime; the plugin will be broken on this host no
matter how clean the install is.

## 5. Detect an existing install

Read the record before touching anything. From inside a shell:

```bash
node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.env.KIMI_CODE_HOME
    ? process.env.KIMI_CODE_HOME + "/plugins/installed.json"
    : require("os").homedir() + "/.kimi-code/plugins/installed.json", "utf8");
  const p = JSON.parse(raw);
  const hit = (p.plugins || []).find(x => x.id === "project-memory");
  process.stdout.write(hit ? JSON.stringify(hit) : "null");
'
```

Read the result and decide:

- `null` → fresh install, jump to step 6.
- `enabled: true` and source `root` matches the managed copy → plugin is
  installed; jump to step 8 (reload) instead of re-installing.
- `enabled: false` → it is disabled; jump to step 7 (enable).
- Present but stale (managed copy does not match source) → re-install;
  see "Stale managed copy" in Troubleshooting before continuing.

Do not blindly re-run `/plugins install` over a healthy install: each
install copies the source again, so a healthy install followed by an
unneeded reinstall is wasteful and confuses `installed.json` mtimes.

## 6. Install

In the chat input, run:

```
/plugins install <absolute-source-path-or-github-url>
```

The plugin is **not** from the Kimi official marketplace, so Kimi shows
a trust prompt that defaults to **Cancel**. Pick the affirmative option
("trust this source" / "install anyway" — wording varies by version).
A `Cancel` lands you with a half-install that the manager reports as
"Removed" — if you see that, just re-run the slash.

After install, Kimi prints the plugin id (`project-memory`) and a
one-line summary. Capture both for the verification step.

## 7. Enable

`/plugins install` enables by default. If the record arrives disabled
or the install reversed:

```
/plugins enable project-memory
```

The `Installed` tab also exposes a `Space`-to-toggle handler; the slash
is the documented scripted path and what you should prefer from chat.

## 8. Reload

MCP servers and plugin-managed skills only re-scan at reload or on a new
session. Until reload, `memory_status` returns "tool not found" even
though `installed.json` looks correct:

```
/reload
```

Use the slash, not the panel. `/reload` is the documented fast path
and is idempotent.

## 9. Verify — every box must pass

1. **Record present and enabled.** Re-run the `node -e …` snippet from
   step 5 and confirm `id: "project-memory"`, `enabled: true`, and
   `root` pointing at `$KIMI_CODE_HOME/plugins/managed/project-memory`.
2. **Manifest clean.** Run `/plugins info project-memory`. A clean
   install prints the interface metadata with no diagnostic block.
   Common diagnostics and their meaning:
   - `Path escapes plugin root` → a declared `mcpServers.cwd` or
     `hooks[].command` points outside the managed copy. Fix the
     manifest and reinstall.
   - `Manifest not found` → the managed copy lost its `kimi.plugin.json`
     during a partial copy. Reinstall.
3. **MCP server live.** The tool list now contains names starting with
   `mcp__plugin-project-memory_kimi-memory__`. If absent, the reload
   did not land — repeat step 8 from a fresh slash.
4. **Read works.** Call `memory_status` with the active project root
   as `cwd`. A `memories.total: 0` payload confirms the SQLite layer
   is reachable. An `ENOENT` on `kimi-memory/<project-key>/memory.sqlite`
   is expected on a fresh project — the database lazy-creates on
   first save, not on first read.
5. **Hooks fire.** On the next `UserPromptSubmit`, the `[kimi-memory]`
   status line appears on stdout. If absent, the lifecycle hooks did
   not register; check
   `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log` (a file every
   failed hook writes to before exiting 0).

Stop and report a failed install on the first box that does not pass.

## 10. Bootstrap a project

The plugin scopes per-project writes by `project_key`, which is the
SHA-256 prefix of the canonicalised project root. It is **not**
auto-detected from Kimi's working directory — every MCP call must pass
`cwd` (the active repo's absolute root) explicitly.

For a new project, the first `memory_save(scope: "project", type, …)`
call is what creates
`$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite`. There is no
pre-create step.

Before saving durable facts to a project, run `memory_recall(scope: "all", query)`
to avoid duplicating an existing memory. If a hit exists, prefer
`memory_update` or `memory_save(..., supersede: true)`. The plugin's
`skillInstructions` makes this explicit; treat it as a rule, not advice.

For cross-project facts (user preferences, reusable workflows), use
`scope: "global"` on `memory_save`. Always still pass `cwd` — it
travels as provenance context, never as the storage target.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/plugins install` exits with no record after a trust prompt | The trust prompt defaults to Cancel; you picked the wrong button | Re-run the slash and pick the affirmative option this time. |
| `Module not found: @modelcontextprotocol/sdk` in MCP logs | Forgot `npm install` in the source dir | Step 3, then `/reload`. |
| `/plugins info` shows `Path escapes plugin root` | A `cwd` or `command` in the manifest resolves outside the plugin root | Edit the manifest — paths must stay inside `kimi.plugin.json`'s directory. |
| `memory_status` returns `Tool not found` | Reload did not run, or the MCP got disabled | `/plugins mcp enable project-memory kimi-memory`, then `/reload`. |
| Hook stdout is silent | Hooks fail-open by design — silent on success is normal | Check `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log` for the full transcript. |
| Project memory mixes with another project | Two repos canonicalise to the same root | By design — same key → same DB. Distinguish the roots. |
| `_global` rows leak into project reads | A read was issued with `scope: "all"` and global hits joined the list | Re-issue with `scope: "project"`. |
| Stale managed copy (source drifted, `/plugins install` no-ops) | Kimi's installer skips when the source path matches the existing managed copy | Remove the record first: `node -e '…'` to mutate `installed.json`, set `enabled: false`, then reinstall. Prefer updating the source and leaving the managed copy alone — re-installing copies every time. |

## What this plugin does NOT do

- **No remote sync.** Storage is local SQLite per machine. Backup is
  the user's problem (`$KIMI_CODE_HOME/kimi-memory/`).
- **No secret enforcement.** `memory_save` accepts anything. The rule
  against storing API keys, tokens, password strings, `.env` bodies,
  and PII lives in `AGENTS.md` and the plugin's `skillInstructions`.
  There is no persist-layer gate; it is a hygiene rule, not a system.
- **No project scope.** Plugins are per-user only — there is no
  per-repo install. For per-repo MCP, write `.kimi-code/mcp.json` in
  the repo; for per-repo memory, pass that repo's absolute root as
  `cwd` on every memory call.
- **No cwd auto-capture.** MCP tools do not see Kimi's working
  directory. Always pass `cwd` explicitly; do not assume.

## References

- Official install path:
  https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html
- Repo layout: `AGENTS.md`
- Plugin manifest: `kimi.plugin.json`
- Storage layout (project + global DBs, diagnostics log):
  `README.md` § "Storage and privacy"
