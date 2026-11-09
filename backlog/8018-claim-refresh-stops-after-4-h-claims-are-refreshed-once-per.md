---
bornAs: x4bj7e0
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/fix-claim-store.mjs", "we:scripts/conveyor/fix-procedure.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# claim refresh stops after 4 h; claims are refreshed once per tick start

Flow-sim gap E-G8, class K1 (liveness false positive). Failing input: live fixer session (verify-lane waits) older than 4 h from claimedAt, or a single tick that blocks longer than the 10 min claim TTL' 'tick start refresh Cited: we:scripts/conveyor/fix-dispatch-claim.mjs:319, we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1546-1557, we:scripts/conveyor/fix-claim-store.mjs:21, we:scripts/conveyor/fix-procedure.mjs:283-308. Soak-break sketch: claim expires under a live session: push guard stops protecting the branch and scope fence drops; a second fixer is prevented only by bindAgents name liveness.

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
