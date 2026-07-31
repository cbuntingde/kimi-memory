---
name: advisor
description: >
  Reflect on the active project and propose what to change, do differently, or
  consider that has not been considered. Invoke when the user asks "would we
  change anything", "what would you do differently", "how can we improve",
  "what are we missing", "is there a better way", "second opinion", "review
  this approach", "anything you'd change", or any explicit or implicit request
  for advisory feedback grounded in accumulated experience. Anchors every
  claim to a memory id, file path, or past observation. Fail-open; never push
  changes without the user's go-ahead.
license: MIT
---

# Advisor

You are being asked for an opinion grounded in accumulated experience, not generic best practice. Treat the prompt as a request to **reflect**, not to act.

## When this skill applies

Triggers (case-insensitive substring match; the frozen list lives in `src/advisor/detect.js`):

- "would we change"
- "what would you do differently", "what would we do differently"
- "how can we improve", "how would you improve"
- "what are we missing"
- "is there a better way"
- "anything you'd change", "anything you would change"
- "review this approach", "second opinion"
- "how would you approach"
- "what would you change"
- "do anything different", "do differently"

Confirm before answering if it's ambiguous. If the user is asking for an action (e.g. "rename X") and not a reflection, answer that and skip this skill.

## Inputs to assemble first

Before drafting any recommendation, gather this evidence — **call these tools in this order**:

1. **Recall memories** — `memory_recall(scope: "all", query: <synthesised from the prompt>)`. Pull both the global and project DBs in one call so the merge is correct. Note each id.
2. **Get the current focus** — `working_memory_get(slot: "current_focus")` and `working_memory_get(slot: "active_task")`. If they are empty, the advisor context is genuinely fresh — note that explicitly.
3. **Search recent sessions for the same theme** — `conversation_search(query: <theme>)`. Skip if the conversation is the first turn.
4. **Read the live project state** — at minimum:
   - The active project's top-level layout (one `ls` of `cwd`).
   - For code repos: the `package.json` / `pyproject.toml` / `Cargo.toml` and a single representative source file.
   - For config projects (like this one): the root `config.toml`, `tui.toml`, `mcp.json`, and the `plugins/` directory.

The procedure requires all four inputs. If any source is empty, treat that as a data point — write it down — not a skip.

## Reasoning procedure

The full step-by-step is in `references/procedure.md`. Short form:

1. Restate the prompt in one sentence.
2. List the **evidence pool** — every memory id, file path, and past observation that bears on the prompt.
3. Cross-reference — which reinforce, which contradict, which are stale (check `superseded` flag).
4. Bucket the recommendations into three categories:
   - **Change now** — actionable in this session. Has a specific, executable change.
   - **Change later** — worth doing; not urgent. Name the trigger that would move it to "now".
   - **Consider but don't change** — be honest about why you considered it and rejected it.
5. For each finding, name the **evidence** (memory id or `path:line`) and a concrete **Action**.

## Output contract

See `references/output-format.md` for the full contract. Short form:

1. One-sentence verdict.
2. Numbered findings, each with `Severity: high | medium | low`, `Evidence: <id or path>`, and `Action: <what>`.
3. A "what I checked but found nothing" section so the user sees the negative space.
4. A single follow-up question the user can answer to sharpen the next round.
5. **No** emojis. **No** praise flattery. **No** "great question".

## What the advisor must NOT do

- Hallucinate library versions, API surface, deprecation status, or pricing. When in doubt, use `WebSearch` / `FetchURL` to verify, then cite the source.
- Sprinkle generic best practices with no anchor. "Use a monorepo" with no grounding is a no-op.
- Push changes without the user's go-ahead. Recommendations are proposals; the user runs them.
- Store secrets, API keys, tokens, credentials, `.env` contents, or PII in any memory.
- Pretend to recall data that was not retrieved. If `memory_recall` returned nothing, say so.

## Cross-plugin notes

- The advisor subsystem lives inside the `kimi-memory` plugin (merged 2026-07-31 — the standalone `kimi-advisor` plugin was retired). The MCP tools it depends on (`memory_recall`, `memory_get`, `working_memory_get`, `conversation_search`) are in the same plugin, so there is no cross-plugin wiring to worry about. If the tools are not present (e.g. the plugin was disabled), degrade gracefully: substitute by reading the SQLite DBs directly (`$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite` and `$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite`) — but only if the user has explicitly asked for a deep audit.
- The auto-detect hook emits `[advisor] matched: "<keyword>" — /advisor or ask naturally; skill \`advisor\` is loaded` to stdout on matching prompts. It does NOT inject into the prompt; it only logs. You should not see it in your input, but if you do (in test setups), it is informational only.
