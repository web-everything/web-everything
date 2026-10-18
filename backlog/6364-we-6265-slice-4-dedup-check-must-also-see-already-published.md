---
bornAs: xmxojbm
kind: story
size: 1
status: open
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# we: 6265 slice 4 - dedup check must also see already-published override-loosening-ended lines

Priority: normal (degraded). [A1] Executable: a vitest test in we:scripts/operations/__tests__/needs-you-feed.test.mjs named "a crash between appending ended events and writing the state does not publish the same ended event twice", extended so the dedup check matches both operator-override#0@<entryId>:override-loosening and operator-override#0@<entryId>:override-loosening-ended in the feed file. Break (red-team, confirmed, degraded): the specified deduplication key does not match ended events. Scenario: an override entry-1 expires between polls; the producer appends its override-loosening-ended event, then crashes before saving the cursor. On restart the history returns entry-1 again. The specified feed-file check searches for operator-override#0@entry-1:override-loosening, but the persisted event has kind override-loosening-ended, so the check permits another ended event. An in-memory probe with the existing parser confirmed these are distinct keys. Fix: the dedup check must treat an already-published ended event as published, so exactly-once publication holds after a crash. Source: PR 5549 red-team advisory, head 71839eecaa6b.

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
