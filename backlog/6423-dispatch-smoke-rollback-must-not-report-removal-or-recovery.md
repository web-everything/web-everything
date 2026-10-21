---
bornAs: xqyusxh
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Dispatch-smoke rollback must not report removal or recovery it did not achieve

we:scripts/lib/daemon-load-overlay.mjs rollBack reports rolledBack/registered:false even when the audit append or the recovery rebuild fails or the post-adopt smoke path never rolled back; the report can claim a rollback that did not happen. Report only what was proven (overlay absent from list AND recovery rebuild adopted).

## Acceptance

- [A1] Executable: we:scripts/lib/__tests__/daemon-load-overlay.test.mjs — a dispatch-smoke failure where the overlay removal, the audit append or the recovery rebuild fails (and the post-adopt smoke path) must report registered/rolledBack/adopted truthfully; red before: the report claims a rollback that did not happen.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the 7 approved prototype relaxations or other guards; fixes only this gap, which is already present on main (pre-existing gap, expedited).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — report only a proven state; unknown or failed recovery is reported as not rolled back and left registered for the operator.
2. **Truncated reads** — the overlay list lock times out: still registered, reported so.
3. **Shared state files** — ref is validated by isSafeBranchName before any git call.
4. **Fail closed** — per-clone overlay list under the clone's own lock.
5. **Identity scoping** — a retry after a partial rollback re-reads the list, never trusts the earlier report.
6. **State over time** — n/a: operator CLI.
7. **Who wrote it** — n/a: operator-run CLI; the overlay audit trail already names the actor.
