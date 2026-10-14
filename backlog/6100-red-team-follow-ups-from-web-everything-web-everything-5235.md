---
bornAs: x24i64r
kind: story
size: 2
status: open
scope: ["we:scripts/operations/pr-ownership.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5235 (head 8dc25610b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5235 (reviewed head `8dc25610b3cbfa474cad9c77a9e1c85eea45e7d9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/pr-ownership.mjs:164` — (failing-input, degraded) Ownership reports mark a PR healthy when its planned next actor is dead.
   - Scenario: Replay we:pr-5157-ci-heal-escalated.json with advisoryReviewOnHumanHandoff=on, producing a review dispatch for a needs-human PR. Assess ownership with no bound session or fix claim and daemons=[{name:'review',state:'dead'}]. The result is owner='human', nextActor='review', ownerDaemonState=null, flags=[], healthy=true. A separate probe remained healthy after 120 owed ticks, also with state='down'. The dead-daemon and overdue checks inspect the phase owner instead of the planned next actor. The report should flag the dead review daemon and the advisory work awaiting dispatch.
   - Claude's re-check: In assessPrOwnership, ownerDaemonState is null whenever owner is 'human' or 'none'. The new dead-daemon branch tests DEAD_DAEMON_STATES.has(ownerDaemonState), so it never fires for a human-owned PR. nextActor='review' with a dead review daemon is only used to suppress the orphan flag (via liveNextActor), never to raise one. So flags stays empty and the PR reads healthy.

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
