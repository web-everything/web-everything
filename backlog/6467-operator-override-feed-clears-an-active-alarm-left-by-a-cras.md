---
bornAs: xul5fz4
kind: story
size: 2
status: open
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# Operator-override feed clears an active alarm left by a crash before state save (slice 4 of PR 5549, card 6265)

[A1] Executable. Red-team break (degraded) on PR #5549 head 71839eec, card 6265 line 28: with empty persisted openKeys, the producer publishes an active override-loosening line then crashes before writing state. The override then expires. On restart the current view is empty, openKeys is empty, so diffFeed emits no clear, and the history rule suppresses the ended event because the active key already exists in the feed file; the active event stays open in unacknowledged() forever. Fix in the 6265 card text: recovery must reconcile appended-but-unsaved active events against the feed file so a clear or ended event is emitted; add a named crash-after-active-append test.

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
