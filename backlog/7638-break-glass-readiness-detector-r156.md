---
bornAs: x1jaq3d
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Break-glass readiness detector (R156)

MED priority hint. ## (held 2026-10-27 08:35 ET) Break-glass readiness detector (R156) The health-watch evaluates the R156 criteria every tick: main red over 60 min plus a fix PR at most 20 lines and low-blast, blocked only by automation, with tests green. It emits needs-you "BREAK-GLASS READY #N" with the diff stat and why the normal path is blocked. Also log every operator force-merge to an audit file. Live case: main red 10-26 21:25Z to 10-27 ~09:00+; #6012 was qualified from ~11:20Z; yesterday the qualifying window opened ~22:30Z (a timeout bump).

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
