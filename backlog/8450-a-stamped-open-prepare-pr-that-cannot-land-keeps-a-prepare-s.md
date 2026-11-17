---
bornAs: xax39pe
kind: story
size: 2
status: active
scaffoldedBy: "fix-5366"
dateScaffolded: "2026-10-15"
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# A stamped OPEN prepare PR that cannot land keeps a prepare slot with no time limit

In the build-dispatch daemon retirement pass, a stamped OPEN prepare PR (stampedOpenPr) skips dead-session and lease-expiry retirement, so the else-branch re-adds the card to prepareBusy every tick, even with a dead owner. Two stamped prepare PRs that cannot land (red CI, a merge conflict) take both prepare slots (cap 2) and stop every prepare until a person acts. Its OPEN PR already refuses a re-launch, so the slot is not needed for safety. Tests 'keeps a dead-owner claim whose open PR is stamped' pin today's behaviour deliberately, so this is a policy decision: free the slot, or bound it by age. Related: the retirement catch block re-pins a tracked card's slot on every tick while its status read keeps throwing (card removed from main, PR head lacks the card). Surfaced by the PR #5366 round-7 self-review; pre-existing on main.

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
