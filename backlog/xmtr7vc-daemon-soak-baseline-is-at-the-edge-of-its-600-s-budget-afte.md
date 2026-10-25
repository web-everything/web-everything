---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Daemon soak baseline is at the edge of its 600 s budget after the paged drain listing

[held entry 284] (2026-10-13, held) Daemon soak baseline is at the edge of its 600 s budget after the paged drain listing: locally ~37/50 ticks in 600 s (10.7–21.4 s per tick); it passed in CI on #5244 but is likely flaky. Cut per-tick fake-gh cost (paged reader reusing per-PR details inside the soak; cheap fake page answers). Do not raise the timeout or cut ticks. (A Codex attempt left an untested fake-gh server + C client in released lane-15 — discard; prefer the reuse fix.)

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
