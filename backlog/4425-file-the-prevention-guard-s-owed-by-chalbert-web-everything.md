---
bornAs: xii3yhk
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-09-28"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2864's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/verify-dispatch.mjs:424` — Add a deterministic integration gate with more lanes than capacity and gates lasting beyond admission timeout; assert peak actual gate execution, including unslotted children, remains within capacity.
2. `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:280` — Use a synchronized fixture that remains running after emitting the marker, assert callback delivery before releasing it, and verify the dispatcher's timestamp wiring. This coverage follow-up is filed in backlog/4373.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2864@f212eaa573fca100b865fc6fa7c2bf1c1c48f438

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Findings (standalone worker, 2026-10-10)

The build-dispatch daemon held #4425 with:

> worker-declined: could-not-prepare — the requested invariant needs a policy choice. 'we:scripts/readiness/heavy-admission.mjs:946–948' explicitly permits unslotted execution after the hard ceiling; 'we:scripts/verify-lane.mjs:548–564' continues execution on that outcome. Therefore, bounding **all actual gates**, including unslotted children, requires changing that behavior. The unresolved choice is whether to preserve fail-open admission and narrow the guard, or require strict capacity enforcement after the ceiling. Existing tests cover ordinary contention, not this case. Left no diff or stamp. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
