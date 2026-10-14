---
bornAs: xponaiq
kind: story
size: 2
status: open
scope: ["we:scripts/operations/pr-ownership.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5235 (head 47e45cac8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5235 (reviewed head `47e45cac880c025756dd17aae76059b2f7d87558`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/pr-ownership.mjs:164` — (failing-input, degraded) A dead planned next actor is reported as healthy when the phase owner is human.
   - Scenario: Call assessPrOwnership with number:5157, phase:'needs-human', no bound sessions, a plan dispatching kind:'review', and daemons:[{name:'review',state:'dead'}]. It reports nextActor:'review' but flags:[] and healthy:true. The same occurs with state:'down', even after 180 reconcile ticks without a session. Read-only probes verified both. The new code reads nextActorState but checks ownerDaemonState for failure; ownerDaemonState is null for the phase's human owner. Health and owed-work flags should assess the daemon responsible for the planned next move, surfacing its known death.
   - Claude's re-check: With phase needs-human, ownerFor gives owner 'human', so ownerDaemonState is null. nextActor is 'review' with state 'dead', so liveNextActor is false. The orphan check tests only ownerDaemonState, and DEAD_DAEMON_STATES.has(null) is false. flags stays empty and the PR reads healthy even though the planned next actor is dead.

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
