---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The same card is re-prepared again and again without being built

[held entry 299] (coroner 2026-10-13, held — PREMISE: confirm the trigger) The same card is re-prepared again and again without being built. 41 prepare commits landed on main today; card 5762 x5 (8+ prepare PRs total), 5745 x4, 4413/5954 x3; each only bumps preparedAgainstSha and refreshes citations. prepare-item sessions: 44, 301 min; builder log: repeated-same-card 88/96. Fix idea: re-check drift lazily at build dispatch (only if cited lines changed), cap re-prepares per card per day (setting), and skip re-prepare while the card is not within prepareAheadWindow (card 80). Evidence: git log origin/main we:backlog/5762-*, we:coroner2.json builderLaunches. Scope: we:scripts/conveyor build-dispatch prepare path. Size 3.

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
