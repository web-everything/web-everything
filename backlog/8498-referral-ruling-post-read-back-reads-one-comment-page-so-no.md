---
bornAs: xmglhub
kind: story
size: 2
status: active
scaffoldedBy: "fix-6529"
dateScaffolded: "2026-11-08"
dateOpened: "2026-11-08"
tags: []
related: ["6529"]
---

# Referral ruling post read-back reads one comment page, so no clearing ruling can land on a 100+ comment PR

The operator-ruling post sink checks already-posted and reads back its comment through gh pr view --json comments, which returns one page of 100. On a longer thread a correct clearing ruling fails read-back, is reverted to a hold every time and may be re-posted as a duplicate. Fail-safe, but it blocks rulings on busy PRs. Route both reads through the complete paginated reader when the page is at the cap.

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

## Duplicate admission

found by the PR 6529 round-2 self-review
