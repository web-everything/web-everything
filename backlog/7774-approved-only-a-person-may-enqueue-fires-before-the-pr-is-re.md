---
bornAs: xex9z1s
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# "approved, only a person may enqueue" fires before the PR is ready

MED priority hint. ## (held 2026-10-27 15:45 ET) "approved, only a person may enqueue" fires before the PR is ready #5990/#6006/#5981 raised "approved, only a person may enqueue" while red-team was pending and no ready-to-merge label was set. Enqueuing then gets the PR ejected by merge-gate candidate-label. #6006 was then enqueued by the merger anyway. Fix: emit this needs-you only when ready-to-merge is present and red-team is clear on the head; otherwise stay silent. Also re-check whether the item is person-only at all (the merger enqueued #6006).

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
