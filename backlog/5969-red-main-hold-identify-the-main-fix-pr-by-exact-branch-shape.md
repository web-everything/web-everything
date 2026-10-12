---
bornAs: xxanl0v
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/lib/red-main-hold.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Red-main hold: identify the main-fix PR by exact branch shape or owner record, never by title words

Held finding 213 (2026-10-10, safety). Live 19:58Z the drain hold said only main-fix PRs #4814, #4813, #4812 land, but #4813/#4814 are ordinary feature PRs whose titles/branches mention main-fix; only #4812 (lane/main-fix-2cb94418d) fixed the red. findOwnerPrs in main-ci-red-core matches the title pattern and any branch starting lane/main-fix- (so lane/main-fix-queue-priority matches). Fix: match only lane/main-fix-<sha9> for the current first-red sha (or the owner record main-ci-red-io publishes), drop title-word matching, and log the matched rule. Test with the three live PRs.

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
