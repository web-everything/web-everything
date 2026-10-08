---
bornAs: xx2620y
kind: story
size: 8
status: open
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/backlog.mjs", "we:scripts/readiness/", "we:scripts/lib/review-core.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement on every card: required Acceptance and Non-goals, and reviewers judge the diff against them

Operator 2026-10-08 (from the Harness Engineering article review): only ~740 of 5,051 cards state acceptance criteria and ~345 non-goals; we:scripts/backlog.mjs and we:scripts/operations/file-item.mjs do not require either. (1) file-item and the card template require Acceptance and Non-goals sections; the readiness check refuses to dispatch a story card without them. (2) Review jurors and the converge loop judge the diff against the card's acceptance list, catching a build that solves an easier task and calls it done. Touches every card and every brief: PREPARE FIRST (decide rollout for the existing 5,000 cards, enforcement mode advise then enforce as a knob, and how reviewers read the list).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
