---
bornAs: x5uafak
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Run the grouping planner against projectBuildQueueRow output in a daemon-level test with a mixed-… (from web-everything/web-everything#5187 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:720` — Run the grouping planner against `projectBuildQueueRow` output in a daemon-level test with a mixed-repo fixture. Better, have the daemon overlay `rawScope` (or the card's qualified scope) into the grouping rows for repo comparison.
2. `we:scripts/operations/deliver-item-wrapper.mjs:735` — Add a check:standards rule or lint that flags readFileSync on a lane-relative path inside deliver-item-wrapper unless it is guarded by lstat or O_NOFOLLOW. Always run thrown messages that carry agent-supplied text through sanitizeGroupDropReason.
3. `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:4437` — Add a review lens or checklist item: every 'refuses X' or 'only Y' sentence in a docblock needs a negative test that names the refused input.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5187@dd82d7c4267f4c78b930680c751e267f64e71e07

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
