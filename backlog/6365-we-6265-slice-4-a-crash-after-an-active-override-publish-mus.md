---
bornAs: xx8epqz
kind: story
size: 1
status: open
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# we: 6265 slice 4 - a crash after an active override publish must still clear its alarm

Priority: normal (degraded). [A1] Executable: a vitest test in we:scripts/operations/__tests__/needs-you-feed.test.mjs named "a crash after publishing an active override clears it once it expires", where the active override line is appended, the state write is skipped (simulated crash), the override expires, and the next run must emit NEEDS-YOU-CLEARED for its key and unacknowledged() must no longer list it. Break (red-team, confirmed, degraded): a crash after publishing an active override can leave its alarm permanently uncleared. Scenario: start with empty persisted openKeys. Publish an active override-loosening line, then crash before writing state. Let the override expire before restart. The next current view is empty and persisted openKeys is still empty, so diffFeed emits no clear. The history rule also suppresses the ended event, because the active key already appears in the feed file. The active event therefore stays open in unacknowledged() after expiry or a safe replacement. A read-only probe of the existing diffFeed confirmed the missing clear. Fix: recovery must reconcile active override lines already appended to the feed file into openKeys (or equivalent), so a later expiry or supersede emits the clear. Source: PR 5549 red-team advisory, head 71839eecaa6b.

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
