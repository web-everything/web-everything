---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: cache persistent overlay pin retry outcomes by complete planning inputs

PR #5809 review identified repeated bounded subset replanning while pins persist across daemon ticks. Memoise retry outcomes by complete planning inputs, including main, live carried heads, overlay tips and registrations, pin set, stack mode and edge approvals. Do not use the existing applied-only inputsKey without proving it includes all retry-relevant changes. Preserve full-set and singleton retries plus the 64 joint-subset budget. Add a persistent-ticks test that counts planner entries and proves invalidation when any relevant input changes. Immediate six-pin exhaustion and seven-pin budget tests are included in the repair.

## Acceptance

- [A1] **Executable** — Add a named test in we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs that counts replans across two unchanged pinned ticks: the second tick reuses the retry outcome, and every retry-relevant input change forces a fresh search. Run through the normal unit and diff-selected verify gates.
- [A2] Preserve the six-pin exhaustive search and the seven-pin limit of 64 extra joint retries; cache exhaustion as a conservative outcome without changing retry parity.
- [A3] Prove invalidation for changed main, carried heads, new conflicting tip, overlay membership/order, pin policy, stack mode and approved resolution edge; bound cache size and discard incompatible state versions.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No increase to retry budgets and no change to smoke, loss protection, or authorization requirements.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Canonically encode cache-key inputs; never concatenate refs or paths into commands.
2. **Truncated reads** — Unknown or failed Git reads cannot authorize a cached adoption; replan or hold.
3. **Shared state files** — Use the existing clone lock and atomic state writer; test two writers and a stale resumed holder.
4. **Fail closed** — Corrupt, stale or incomplete cache entries cause fresh planning, never overlay loss or smoke reuse.
5. **Identity scoping** — Cache per clone and exact carried-overlay identity, including PR reuse of a branch.
6. **State over time** — Test unchanged ticks, force pushes, changed policy and recovery after interrupted state writes.
7. **Who wrote it** — Cached planning outcomes are optimization hints and never trusted smoke evidence.
