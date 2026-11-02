---
kind: story
size: 2
status: open
scope: ["we:daemon-clone-lock.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #22 single-owner rebuild PARKED

MED priority hint. - (MED, 11-02 10:43 ET) #22 single-owner rebuild PARKED: lane/clone-single-owner 3c3e0650a6 (verify green). Its live needs are now met elsewhere (fix daemon healed by #6251 + bootstrap; reader starvation removed by R418 own clone). Open audit findings if resumed: (1) missing/stale owner heartbeat → every sibling owns (no election); (2) every non-success (incl. job-running, lock contention) spends the failure budget; (3) deferred mutation marked handled after exception/lock refusal. Pre-existing (R412) in we:daemon-clone-lock.mjs: reader locks not renewed (>10 min tick expires), corrupt/missing writer file lets reads through → own card.

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
