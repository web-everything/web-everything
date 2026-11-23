---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/soak/daemon-soak.soak.test.mjs", "we:scripts/lib/test-tmp-root.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# daemon-soak 50-tick test times out at 1020 s in the merge queue (blocks PRs 7348, 7329)

The merge queue's we:scripts/conveyor/soak/daemon-soak.soak.test.mjs ('50 real daemon ticks') hits its 1,020,000 ms timeout on unrelated PRs (7348 and 7329 queue runs, 2026-11-22), then global teardown fails with ENOTEMPTY on the sim-world tmp dir. Find why the 50 ticks now exceed the budget (a slow tick, a hung child, host load) and why a still-running child leaves files in teardown; fix at the cause. Evidence: soak-shard (1) and daemon-soak failed on both queue runs.

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
