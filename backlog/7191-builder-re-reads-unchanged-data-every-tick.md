---
bornAs: xxgaqyc
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Builder re-reads unchanged data every tick

[held entry 314] (daemon-async-audit 2026-10-14, held — relates 5764) Builder re-reads unchanged data every tick. fetchOpenPrs makes one blocking files call per PR, one at a time (mean 105 s, median 39 s; 86% come back 304). The backlog (6,051 cards) is parsed 3× per tick (we:conveyor-state.mjs:892, we:dispatch-plan.mjs:976, we:build-dispatch-daemon.mjs:1415). prepare-status runs a git fetch + a 500-PR search every tick (prime 13 s, read 11 s). listSettledPrepares re-reads the run store (5.9 s mean, max 102 s). Fix idea: files keyed by head SHA (or read files from the shared snapshot if it carries them), 4-wide; the parsed backlog once per tick keyed by tree hash; incremental prepare listing (updated-since); pass {records} into listSettledPrepares; add subTimings. Design: cache + parallel. Evidence: build-dispatch-daemon.log timings; we:open-pr-fetch.mjs:89-104, we:build-dispatch-daemon.mjs:1904-1960,2354. Saves 60–130 s/tick. Size 3.

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
