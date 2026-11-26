---
bornAs: xm8dy12
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# we:lane-pool.mjs:2275 The Acceptance guarantee that lane-pool enforces live-cwd protection lacks a named CLI int (web-everything#7499)

1. `we:scripts/lane-pool.mjs:2275` — The Acceptance guarantee that lane-pool enforces live-cwd protection lacks a named CLI integration test.

Operator card follow-up for web-everything/web-everything#7499 (head 10a96fa34cb5fdb5bee1baf2cd53028677174714).

Not worse than main (R903): tests-only gap; guards present and correct on head, nothing regresses vs main (R903)

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
