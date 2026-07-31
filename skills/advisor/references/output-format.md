# Output format contract

The advisor response has a fixed shape. Deviating from it breaks the user's trust.

## Required sections, in order

1. **Verdict** — one sentence, no more.
2. **Findings** — numbered list. Each finding has Severity, Evidence, Action.
3. **Negative space** — a short "what I checked but found nothing" section. The user sees what was _not_ a problem.
4. **Follow-up** — one question.

## Section 1 — Verdict

Exactly one sentence. State the highest-leverage answer to the prompt. Examples:

- "The biggest change worth making is to extract the plugin loader into its own package so it can be tested without the runtime."
- "Nothing in the current setup blocks the goal; what's holding you back is upstream API churn, not local architecture."

Forbidden openings: "Great question", "Certainly", "Sure", "I'd be happy to". Start with the subject.

## Section 2 — Findings

One numbered entry per finding. Use the shape:

```
N. **<one-line title>**
   - Severity: high | medium | low
   - Evidence: <memory id like mem:a1b2c3> | <path:line> | <session ref>
   - Action: <what to do, concretely>
```

- **Numbering** starts at 1 and is sequential across all three buckets. Bucket headers (`Change now` / `Change later` / `Consider but don't change`) sit above their numbered items.
- **Severity** is honest. Don't inflate "consider" items to "medium" to look thorough.
- **Evidence** is concrete. If the finding rests on the conversation alone, say `Evidence: conversation (<turn N>)`. If it rests on code you just read, say `Evidence: ~/.kimi-code/plugins/managed/advisor/kimi.plugin.json:10-15`.
- **Action** is executable. "Refactor the loader" is not an action. "Move `loader.js` into `src/loader/` and add a `loader.test.js` next to it" is.

## Section 3 — Negative space

Two to four bullet points. Each is something the advisor looked for and did **not** find. The user should not have to guess whether the advisor checked.

Examples:

- Checked for stale `superseded` memories in the project DB — none found.
- Checked for deprecated tool calls in the recent config — none.
- Checked for hard-coded credentials in the plugin source — none.
- Checked the gitignore covers the SQLite WAL/SHM files — it does.

This is the single most under-utilised section in advisory output. Do not skip it.

## Section 4 — Follow-up

One question. The question must be answerable in a single sentence by the user. Do not propose a multi-part questionnaire.

Bad examples:

- "Can you tell me more about your goals?"
- "What do you want to do?"

Good examples:

- "Is the goal to ship X sooner, or to make X cheaper to maintain long-term?"
- "Do you want session-end auto-distillation now, or after we have more project history to draw from?"

## Forbidden in advisor output

- Emojis (matches the user's working-style preferences).
- Flattery ("Excellent point", "You're right to ask", "Smart catch").
- Generic best-practice lists with no anchor.
- Bullet walls longer than ~12 items — break into a table or split across calls.
- Markdown headers (`##`, `###`) inside the findings. The reader should scan by number.

## Sample response

```
Verdict: The memory layer is healthy; the one high-value change is to add a `/reflect` style slash command that invokes the advisor procedure explicitly.

Findings
1. **No explicit advisor entry point**
   - Severity: high
   - Evidence: ~/.kimi-code/plugins/managed/advisor/AGENTS.md (missing), memory:procedure-summary (pre-existing procedure but no command)
   - Action: add `/advisor` slash command backed by skill `advisor`.

2. **Hook detection unverified**
   - Severity: medium
   - Evidence: ~/.kimi-code/plugins/managed/advisor/hooks/src/detect.js (new)
   - Action: smoke-test against `would we change anything` and a benign prompt; confirm only the first triggers output.

3. **Seed memories may be redundant**
   - Severity: low
   - Evidence: memory list (compare to existing globals)
   - Action: before saving a new global, run `memory_recall` first; if a hit exists, update or supersede instead.

Negative space
- No stale `superseded` memories in either DB.
- No missing hooks declared in `kimi.plugin.json`.
- No package dependencies declared (pure ESM stdlib).
- No secrets stored anywhere in the managed plugins dir.

Follow-up: Is the goal to make advisory answers richer on day one, or to let them accumulate organically as you use the system?
```
