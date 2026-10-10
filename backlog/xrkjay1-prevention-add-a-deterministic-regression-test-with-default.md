---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a deterministic regression test with default settings that exhausts the cap and asserts that… (from web-everything/web-everything#4655 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-stack.mjs` — Add a deterministic regression test with default settings that exhausts the cap and asserts that the bottom is blocked by the released top's live claim; cover both release paths with the same parameterized test.
2. `we:scripts/conveyor/pr-stack.mjs` — Parameterize the fork-validation regression across planned and unplanned PRs, asserting no new pair when GitHub reports isCrossRepository true even when origin name, tip, and author match.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4655@4d8fc1921fcbcda15fd20bfd1085ca4dc4151ca3

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
