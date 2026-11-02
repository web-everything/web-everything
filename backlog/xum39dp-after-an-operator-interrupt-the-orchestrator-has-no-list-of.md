---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# After an operator interrupt the orchestrator has no list of the workers it stopped, so "Oops restart" was misr

MED priority hint. 395. (coroner-1031, held, MED) After an operator interrupt the orchestrator has no list of the workers it stopped, so "Oops restart" was misread and the restart took 31 min. Interrupts at 18:01 and 18:21 ET stopped 4 workers (7533, #6141 rebase, holder PR, speed); "Oops restart" (18:03 ET) meant "restart them" and was read as "restart the analysis"; fresh workers started 18:34 ET; lanes 44, 17, 55 still need `reclaim --salvage` and 7533 commits sat unpushed. Card 160 would remove the cause (detached durable jobs) but is unbuilt.     Fix idea: the harness hook on a stopped subagent writes one ledger line (agent id, lane, branch@sha, brief file, unpushed commits) so `restart` resolves against it and the lane salvage runs automatically; until 160 lands.     Evidence: handoff 18:35 ET entry; operator turns 18:03, 18:18, 18:21 ET. Scope: we:.claude/hooks, we:scripts/lane-pool.mjs. Size 3.

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
