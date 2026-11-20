---
bornAs: x8c61dn
kind: story
size: 5
status: open
dateOpened: "2026-11-19"
tags: []
---

# Expectation babysitter S1.1: lock reclaim, audit findings, stale-hold and CLEAN-not-enqueued emitters

Follow-ups to PR 7190 (observe-only babysitter). (1) State lock dir <state>/expectation-babysitter/<repo>.json.lock left by a stopped pass is never reclaimed so the next --watch run goes silent (silent 16:02-16:57 ET): add owner pid + age staleness reclaim and a loud error when it cannot lock. (2) Dedupe receipt is saved after the append: reserve before append or make idempotent. (3) Gate and review detection by check name only: validate producer or workflow. (4) Committer timestamp can discard an overdue trigger while evidence reads complete. (5) Reader declares evidence complete without verdict, fixer, adoption or hold evidence: those must stay unknown. (6) Corruption tests share already-corrupted inputs, every() accepts empty results. (7) update-branch events carry detail.afterHead: parse it. (8) Add emitters for publication-hold-set and enqueue-eligible so the stale-hold and clean-not-enqueued rows can fire. (9) Only this feature's own settings taint is honoured: reconsider duplicate-key taint from other files. Supersedes orphaned card xk4y7oa.

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
