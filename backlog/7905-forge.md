---
bornAs: xrliesw
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# (Forge)

HIGH priority hint. - (2026-11-01 01:34 EST) HIGH (Forge): we:remote-exec.mjs treats check:standards' normal 'no changed tier lines; nothing to attribute' output as an INCOMPLETE remote result → falls back to local and defers under load (the real cause of the 10-31 10:40 ET deferral; reproduced live by the #6150 worker). Fix in we:scripts/readiness/remote-exec.mjs result classification.

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
