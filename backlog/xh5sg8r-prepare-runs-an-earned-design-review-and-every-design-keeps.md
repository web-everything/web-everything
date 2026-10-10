---
kind: story
size: 5
status: open
blockedBy: ["xz2yynk", "xug956g"]
scope: ["we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/jury/", "we:scripts/lib/review-core.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prepare runs an earned design review, and every design keeps a decision record reviewers read first

Held item 202 (session 2026-10-10; operator OK; build after 201/194). Today prepare runs one same-session adversarial subagent (we:skills-src/conveyor/prepare-item-agent-brief.md step 5): not independent, no cross-provider. (a) When the card earns it (predicted care level >= elevated from its scope via review-core shape, or size >= 5, a decision/statute card, or it touches single-writer invariants), prepare runs the subject jury (decision-prose; independent headless jurors + Codex + red team on accept) and folds findings into the card before the PR; small routine cards keep today's single pass. Setting `prepare.designReview: off|shadow|earned|always` via the cascade; ship `shadow`, then `earned`. (b) Operator, 2026-10-10: "design should keep record of decision so reviewers are aware" -- every prepared card/design carries a `## Decision record` (decision, who, when, source link; settled vs open); jurors, PR reviewers and the fixer receive it as settled context and may re-open a settled decision only with new evidence (cuts ruling churn like #4631/#4689). Evidence: coroner "checklist-lacked-requirement" is the top cause of review rounds. Related: #2575 (decision record schema), #3770 (design-review operation).

## Acceptance

- [A1] **Executable** — a test shows an earned card (size >= 5) runs the jury in prepare and a routine card does not; reviewer context includes the card's `## Decision record`.
- [A2] **Live** — one earned prepare runs the jury in `shadow`, and one PR review shows the decision record injected as settled context.

## Non-goals

- [N1] Changing the PR review jury itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — The decision record is card text; it is passed to jurors as quoted context, never as instructions.
2. **Truncated reads** — A missing or truncated decision record is treated as "no settled decisions", not as an empty ruling set.
3. **Shared state files** — n/a: prepare writes only its own card in its lane.
4. **Fail closed** — If the jury cannot run, prepare falls back to today's single pass and logs it (setting decides).
5. **Identity scoping** — Decision records are per card.
6. **State over time** — Settled entries re-open only with new evidence cited.
7. **Who wrote it** — Records name who decided and when; jurors cannot mark an entry settled themselves.
