---
kind: story
size: 2
status: open
scope: ["we:docs/agent/testing.md"]
dateOpened: "2026-11-02"
tags: []
---

# (evidence for card 390/7541 xbusgij) Deleted-ref overlay registrations should auto-resolve

HIGH priority hint. - [HIGH 2026-10-31 11:20 ET] (evidence for card 390/7541 xbusgij) Deleted-ref overlay registrations should auto-resolve. prototype-load refused `check-unverifiable` on wev-fix-daemon (lane/fix-daemon-skip-empty, PR #6092 merged) and wev-health-watch (lane/overlay-main-sync-attr, PR #6108 merged): the registered ref was deleted from the remote after merge. Hand steps needed: gh pr list --head, merge-base --is-ancestor main, daemon-overlay remove. The fix daemon also stayed held 33h on last-known-good (established-overlay-conflict lane/unfreeze-fix-top-1030a-m1, we:docs/agent/testing.md) until a manual merge-main -m2 ref was registered and -m1 removed. Product fix: rebuild/prototype-load auto-retires a registration whose ref is gone, PR merged and tip is an ancestor of main; main-sync should spawn the merge-main -mN ref for a doc-only overlay conflict.

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
