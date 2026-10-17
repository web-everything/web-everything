---
kind: story
size: 3
status: active
scaffoldedBy: "redteam-comment-retry"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# A head whose red-team comment is owed is not held by the already-reviewed hold

When a post-accept red-team result is saved but its PR comment is missing, the review daemon's 'already reviewed N time(s)' hold keeps the head from re-running, so the drain's red-team hold never clears (live: PR #5461, head 3373a33). Lift the hold once per head when a saved red-team evidence row (or job log) exists but no we:red-team-advisory comment for that head is on the thread, so the next run reaches resumeRedTeam. Setting redTeam.reArmOnMissingComment, default on.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` fails before this item lands (owed head lifts once; comment present holds; other heads hold; setting off holds) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the drain red-team hold, or run any new model call.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new surface beyond the existing readers.
2. **Truncated reads** — n/a: no new surface beyond the existing readers.
3. **Shared state files** — n/a: no new surface beyond the existing readers.
4. **Fail closed** — n/a: no new surface beyond the existing readers.
5. **Identity scoping** — n/a: no new surface beyond the existing readers.
6. **State over time** — n/a: no new surface beyond the existing readers.
7. **Who wrote it** — n/a: no new surface beyond the existing readers.
