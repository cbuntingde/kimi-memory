# Claude Dreams and Idle Memory Consolidation

**Date:** 2026-08-18 **Audience:** kimi-memory maintainers **Depth:** standard

## 1. Executive Summary

High confidence that Claude “Dreams” is an official Claude Platform managed-agent research-preview capability, not merely the community `dream-skill` rumor. The official design reads an existing memory store plus 1–100 past session transcripts and asynchronously creates a separate output memory store; the input is never mutated. This is materially different from kimi-memory’s current local `src/consolidate.js`, which performs deterministic embedding clustering and can soft-merge rows in place during `SessionStart`. kimi-memory can implement the useful local equivalent, but should add an idle/session-end trigger, immutable candidate output or transactional staging, and explicit review/promote semantics before replacing active memories.

## 2. Credibility Overview

| Source                                                                                                      | Type                           | Credibility | Used for                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------: | -------------------------------------------------------------------------- |
| [Claude Platform Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams)                   | Official product documentation |      96/100 | Definition, input/output behavior, research-preview status                 |
| [Claude Dreams API reference](https://platform.claude.com/docs/en/api/beta/dreams)                          | Official API reference         |      98/100 | Async job model, parameters, lifecycle, output store, cancellation/archive |
| [Claude Code hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks)                         | Official product documentation |      94/100 | Session/turn hook lifecycle and async hook constraints                     |
| [grandamenium/dream-skill](https://github.com/grandamenium/dream-skill)                                     | Community implementation       |      62/100 | Practical 24-hour Stop-hook pattern and four-phase workflow                |
| [AutoDream guide](https://zenvanriel.com/ai-engineer-blog/claude-code-autodream-memory-consolidation-guide) | Independent commentary         |      48/100 | Community claims about rollout and UX; not treated as proof                |
| GitHub search results                                                                                       | Platform search                |      30/100 | Confirms discoverability only; no implementation evidence                  |
| Reddit search                                                                                               | Community search               |       5/100 | Failed behind anti-bot page; no evidence extracted                         |

The first three sources are primary and sufficient for the core conclusion. Community sources describe a local approximation and should not be confused with Anthropic’s managed-agent API.

## 3. Cross-Validated Findings

### Official Dream semantics

- The official documentation describes Dreams as a research-preview feature that lets Claude reflect on past sessions, curate an agent’s memory, and surface new insights. [sources: Claude Platform Dreams guide 96/100, 2026-08-18; Claude Dreams API reference 98/100, 2026-08-18]
- A Dream reads an existing memory store and session transcripts, then writes consolidated memories to a new output memory store. The input store is never modified. [sources: Claude Platform Dreams guide 96/100, 2026-08-18; Claude Dreams API reference 98/100, 2026-08-18]
- The official API is asynchronous. Its lifecycle includes `pending`, `running`, `completed`, `failed`, and `canceled`; it exposes usage, errors, timestamps, outputs, cancellation, listing, retrieval, and archive operations. [source: Claude Dreams API reference 98/100, 2026-08-18]
- The create request accepts a memory-store input, a sessions input containing session IDs, a model, and optional instructions. The API documentation specifies 1–100 sessions in the managed-agent guide. [sources: Claude Platform Dreams guide 96/100, 2026-08-18; Claude Dreams API reference 98/100, 2026-08-18]

### Idle/background behavior

- The official Dreams API documentation does not establish that Claude Code’s local editor runs Dreams merely because the editor is idle. It documents a server-side asynchronous job for managed agents. [source: Claude Dreams API reference 98/100, 2026-08-18]
- Claude Code hooks provide lifecycle points such as `Stop`, `SessionEnd`, and `SessionStart`, and support asynchronous command hooks. Async hook output is delivered on a later turn; if the session is idle, it waits until the next user interaction. [source: Claude Code hooks reference 94/100, 2026-08-18]
- The community `dream-skill` approximates idle behavior by checking at session exit whether 24 hours have elapsed since the last Dream, then flagging the next session to run Dream. This is useful operationally but is not primary evidence about Anthropic’s internal Claude Code implementation. [source: dream-skill 62/100, 2026-08-18]

### kimi-memory comparison

- kimi-memory already has a local “dream” consolidation pass in `src/consolidate.js`, invoked from `handleSessionStart` in `src/hooks/run.js`.
- The current pass clusters active embedded memories using cosine similarity and shared tags, creates deterministic `conclusion` memories, and optionally soft-merges tight clusters. It is bounded and fail-open.
- The current behavior is therefore a partial implementation of “combine and consolidate,” but not a faithful implementation of the official safety model: it mutates the live database during `SessionStart`, rather than producing a separately reviewable output store.
- The current project has no `Idle` hook. `Stop` archives/extracts session data, `SessionEnd` performs end-of-session work, and `SessionStart` runs consolidation and housekeeping.

## 4. Contradictions and Open Questions

1. **“Claude Code dreaming” vs official Dreams API** — Community posts and the GitHub skill describe an unreleased or rolling-out Claude Code AutoDream feature, while official documentation places Dreams under Claude Platform managed agents and explicitly labels it research preview. Likely resolution: the community feature is an approximation or early product-adjacent behavior; the documented, verifiable API is the managed-agent capability. Confidence: high.
2. **True editor-idle trigger** — The official sources document asynchronous Dreams and Claude Code hooks, but do not document a local editor idle timer that automatically launches a Dream. This remains unverified. A local plugin must define its own policy: after Stop, after SessionEnd, after N minutes without a prompt, or on next SessionStart.
3. **Whether to use an LLM** — The official Dream uses Claude inference across pipeline stages. kimi-memory’s current consolidation is deliberately no-LLM and deterministic. An LLM-backed pass would improve contradiction resolution and insight generation, but introduces API credentials, cost, latency, prompt-injection risk from transcripts, and a new provider contract.

## 5. Causal Analysis

- **L1 — Direct cause:** incremental memory writes accumulate duplicates, stale facts, and contradictions across sessions; a later consolidation job reads the store plus transcripts and emits a cleaned store.
- **L2 — Motivation:** the output must be more useful than the raw memory log while preserving the ability to review or discard changes.
- **L3 — Structural driver:** memory is written continuously at low latency, while semantic reconciliation is expensive and can be deferred to a background job; immutable output makes this asynchronous workflow safer.
- **L4 — Counterfactual:** if incremental writes were already deduplicated, versioned, and contradiction-aware, Dreams would still add value by mining session transcripts for new patterns and insights. Consolidation is therefore not only garbage collection.

## 6. Recommended Implementation

### Phase 1: safe local idle consolidation (recommended first)

1. Add a `dream`/consolidation job record or a per-project metadata lock so only one pass runs at a time.
2. Trigger only after a completed `Stop` or `SessionEnd`, with a configurable debounce such as `KIMI_MEMORY_DREAM_IDLE_MS`; do not run on every prompt or block the hook.
3. Snapshot active memories and recent session IDs/events into a bounded candidate set.
4. Generate a staged result: new conclusions plus proposed merge/supersede edges, without changing active memories.
5. On the next `SessionStart`, report the pending result and either auto-apply only high-confidence deterministic changes or expose an explicit review/apply operation.
6. Preserve the current deterministic consolidation as a fallback and keep `KIMI_MEMORY_CONSOLIDATE=off` behavior.

### Phase 2: LLM-assisted Dreams (optional)

Add a provider abstraction that accepts a memory snapshot and bounded transcripts, returns structured operations (`create`, `update`, `supersede`, `link`, `discard`), validates every operation, and writes to a separate staged store. Never allow model output to directly delete or overwrite active memories. Require provenance, confidence, source session IDs, and an apply step.

### Trigger recommendation

Do not rely on a long-lived background child spawned by a hook: hook processes are short-lived and the host may terminate descendants. Use `Stop`/`SessionEnd` to enqueue durable work and let the next `SessionStart` or an explicitly launched worker execute it. If a true editor-idle signal becomes available in the host, add it as an optional trigger rather than making it the only trigger.

## 7. Research Limitations and Next Steps

- The official Dreams API is a research preview; request/response shapes may change without the normal deprecation period.
- The public docs do not reveal Anthropic’s internal consolidation prompts, ranking policy, merge thresholds, or local Claude Code implementation.
- Reddit results were inaccessible behind an anti-bot challenge and were not used as evidence.
- The next engineering step should be a design/implementation pass for staged local Dreams, starting with tests around idle triggering, job locking, crash recovery, immutable snapshots, and review/apply behavior.

## Appendix: Repo Fact Ledger

|   # | Claim                                               | Evidence                                | Confidence |
| --: | --------------------------------------------------- | --------------------------------------- | ---------: |
|   1 | Local consolidator exists                           | `src/consolidate.js:1-24`               |        100 |
|   2 | It clusters by cosine and tag overlap               | `src/consolidate.js:29-34, 150-191`     |        100 |
|   3 | It can auto-merge tight clusters                    | `src/consolidate.js:383-461`            |        100 |
|   4 | It runs at SessionStart                             | `src/hooks/run.js:908-935`              |        100 |
|   5 | Stop hook archives/extracts session work            | `hooks/stop.js:1-4`, `src/hooks/run.js` |        100 |
|   6 | No explicit idle hook is registered                 | `src/hooks/run.js:1533-1542`            |        100 |
|   7 | Official Dream input is not mutated                 | Official Dreams guide/API               |         98 |
|   8 | Official Dream is asynchronous                      | Official Dreams API                     |         98 |
|   9 | Community skill checks 24-hour elapsed time at exit | `dream-skill` README                    |         62 |
|  10 | A local staged implementation is feasible           | Repo architecture + API semantics       |         90 |
