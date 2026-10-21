---
bornAs: x7iyb9j
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x77rl7p-resumed-card-batch-seal-must-restore-hold-protection-before.md", "we:backlog/x8upf00-red-team-seat-helpers-must-check-results-before-treating-a-r.md", "we:backlog/xqyusxh-dispatch-smoke-rollback-must-not-report-removal-or-recovery.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Require a deterministic card check for guarantee-to-test mappings containing a repository-qualifi… (from web-everything/web-everything#5668 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6421-resumed-card-batch-seal-must-restore-hold-protection-before.md:18` — Require a deterministic card check for guarantee-to-test mappings containing a repository-qualified file, planned case name, and assertion. In we:scripts/operations/__tests__/card-batch-seal-io.test.mjs, plan restoreFailureRefusesPublication (no push/ready/merge), truncatedStateRefusesResume (no side effects), nonOwnerCannotResume, identityMismatchRefusesResume, and stateWriteIsAtomicUnderLease, with explicit assertions for each promised safeguard.
2. `we:backlog/6422-red-team-seat-helpers-must-check-results-before-treating-a-r.md:18` — Gate cards on explicit guarantee-to-test mappings. In we:scripts/operations/__tests__/review-extra-seats.test.mjs, plan wrongPrEvidenceIsRejected using matching head/run but a different PR, and unreadableEvidenceRunsRedTeam asserting an actual red-team invocation after a read failure. Include named cases for truncated and non-array record lists.
3. `we:backlog/6423-dispatch-smoke-rollback-must-not-report-removal-or-recovery.md:18` — Gate cards on explicit guarantee-to-test mappings. In we:scripts/lib/__tests__/daemon-load-overlay.test.mjs, plan partialRollbackRetryRereadsList (change list state between attempts and assert fresh-state reporting), lockTimeoutReportsStillRegistered (registered true and rolledBack false), unsafeRefMakesNoGitCalls, and rollbackUsesOwningCloneLock (assert the lock and list paths). Give each A1 failure case explicit expected registered/rolledBack/adopted values.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5668@30396013753418b7dc28f673021e82cfb3b0d205

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
