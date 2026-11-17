---
bornAs: x81xpgv
kind: story
size: 3
status: active
scaffoldedBy: "fix-5366"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/conveyor/prepare-pr-match.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/prepare-failure-policy.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prepare launch park on stamp-completed needs-you records is invisible: not in needsYou, not card-edit releasable

Found by PR #5366 fix self-review. prepareLaunchRefusal parks on held||completed needs-you records, but the needsYou list and card-edit release only consider held&&!completed. A stamp-completed needs-you card re-planned for prepare is refused silently (console.error only). Live ledger: #5754, #5694 newest records are in that state. Also harden releasedAttempt to normNum both target and num (guard passes normNum(num), settle code passes raw f.num).

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
