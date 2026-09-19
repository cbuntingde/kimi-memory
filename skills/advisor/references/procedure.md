# Advisor procedure

Step-by-step. Read once before answering any advisor question; reread on disagreement.

## Step 1 — Restate the prompt

In one sentence, what is being asked? Examples:

- "Is the prompt asking whether any concrete configuration should change right now?"
- "Is it asking for a procedural shift — should we approach this problem differently?"
- "Is it asking for a strategic review — what should we deprecate or add?"

If the prompt has more than one component (e.g. "what should we change about X _and_ Y?"), split them and answer each separately.

## Step 2 — Build the evidence pool

List every input that bears on the restated prompt. Use the format below — every item must be **citable**:

```
- <kind>: <id or path>
  <one-line summary of the relevant claim>
```

`<kind>` is one of: `memory`, `file`, `session`, `observation`. The list is the advisor's receipts.

Run `memory_recall` until the pool stabilises (no new items appear on a second pass). If the pool is empty after two passes, that **is** the finding — say so in the output.

## Step 3 — Cross-reference the evidence

Three checks per item:

1. **Contradicts another item?** Resolve by recency: prefer the row with the latest `updated_at`. If still ambiguous, flag for the user.
2. **Stale?** Check the row's `status` field — anything `superseded` is not load-bearing. Drop or de-emphasise, but don't hide.
3. **Reinforces another item?** Group them. A finding backed by two independent memories carries more weight than one backed by a single memory.

At the end of this step you should have, per finding, 1–3 supporting citations.

## Step 4 — Bucket the recommendations

Three categories, all required:

| Bucket                        | Definition                                                                          | Severity range                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Change now**                | A specific, executable change. The user can run it in this session if they say yes. | high or medium                                                           |
| **Change later**              | Worth doing; blocked by something external or not worth the cost now.               | medium or low                                                            |
| **Consider but don't change** | A real option that the advisor weighed and rejected, with a one-line reason.        | low — explicit "considered, no change" entries are valuable for the user |

If all three categories are empty for a prompt, the prompt has no actionable answer — say so explicitly.

## Step 5 — Format the response

Hand the three buckets to `references/output-format.md` and follow that contract. Each finding must carry:

- **Severity** — high (do this), medium (do this when convenient), low (note only).
- **Evidence** — list the citable items from step 2 that drove this finding.
- **Action** — a concrete next step the user can take. No "consider" without specifying what to do.

## Step 6 — Close with a follow-up

One question, not five. Pick the one that would most sharpen the next round of advice (e.g. "Is the goal to ship X sooner or to make X cheaper to maintain?"). Skip the question if the prompt was already unambiguous.

## Anti-patterns to watch for

- **Confirmation bias.** If the user's framing assumes X is true, don't accept X without checking. Pull the evidence pool first.
- **Decoration with no anchor.** Every sentence that ends with "this would be best practice" without naming the source is a smell.
- **Action outside the prompt scope.** If the user asked "should I rename this var?", don't add "and also you should migrate to TypeScript". Off-scope items go in the **Consider but don't change** bucket at most.
- **Stale memories.** A memory from six months ago that isn't contradicted today is _still_ the current knowledge — but if the user mentions newer evidence in the conversation, the conversation wins.
