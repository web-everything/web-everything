---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/prototype-load.mjs", "we:scripts/operations/prototype-load-io.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# prototype-load reports registered-pending (not FAIL adoption-timeout) and the rebuild emits overlay-adopted / overlay-adoption-overdue

Held card 2026-11-01 12:03 ET. #6182 made the load return fast, but a registered overlay that simply waits for the next rebuild must read registered-pending, never FAIL adoption-timeout (4x on 2026-11-01: build, review, drain x2). The rebuild itself (we:scripts/lib/daemon-rebuild/adopt.mjs) then emits overlay-adopted, or overlay-adoption-overdue after a bound, so nobody polls merge-base by hand. File only what #6182 left undone; check its landed behavior first.

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
