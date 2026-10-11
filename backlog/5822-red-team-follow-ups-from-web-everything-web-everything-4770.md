---
bornAs: xx9fszb
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4770 (head 548ece303)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4770 (reviewed head `548ece3032cbb0d8e05d9382acce6a648a81168f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/mechanical-round-cap.mjs:193` — (failing-input, degraded) The mechanical proof permits unrelated edits anywhere in a base-changed file
   - Scenario: Parent A changes only we:feature.js; main changes a comment at we:config.js:1. Merge main into A and additionally change we:config.js:100 from requireAuth=true to false, despite there being no conflict there. With a trusted conflict-round marker and a verdict on A, injected git outputs representing this graph make readMechanicalRoundFacts return proven:true and mechanicalRoundGrant return action:'review', allowance:1. The filename subset check cannot establish the claimed 'only conflict hunks' restriction. This substantive extra edit should fail the mechanical proof and retain the normal cap.
   - Claude's re-check: The proof checks only file names: 'outside = changed.filter(f =&gt; !baseChanged.has(f))'. An extra edit in a file main also changed (we:config.js) is in 'changed', because it differs between diffPrior and diffHead. It is also in 'baseChanged', so 'outside' is empty, 'proven' is true, and the grant is review with allowance 1. Hunk-level edits are never checked.

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

## Also raised by

- Also raised by web-everything/web-everything#4770 (finding 1: `we:scripts/conveyor/mechanical-round-cap.mjs:219` — failing-input, degraded Unrelated edits within a base-changed file are incorrectly proven mechanical.)
