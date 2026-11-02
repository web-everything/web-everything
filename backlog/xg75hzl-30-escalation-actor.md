---
kind: story
size: 2
status: open
scope: ["we:reconcile-core.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #30 escalation-actor

HIGH priority hint. - (HIGH, 11-02 08:58 ET) #30 escalation-actor: branch lane/escalation-actor 007ba291 (775 tests). All audit findings since round 1 sit in part (b) (fixer on red-team-held drafts); last: we:reconcile-core.mjs:2783 gateOutcomeForHead accepts a send-back from an OLDER red-team result → bind to latest via liveResultGateState. Next: SPLIT — ship part (a) (2 identical escalations → one takeover/head, #6023 replay proven) alone through canonical audit; part (b) rebuilt on liveResultGateState as its own card.

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
