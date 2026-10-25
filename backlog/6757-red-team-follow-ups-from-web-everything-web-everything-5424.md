---
bornAs: xp6nvr4
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-smells/operator-hold-aged.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5424 (head d177ff48e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5424 (reviewed head `d177ff48e438a3e18a3ad190bdfbea06be873644`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-smells/operator-hold-aged.mjs:43` — (edge-case, degraded) A clearance followed by an already-aged recurrence in one log read loses the recurrence alert.
   - Scenario: Reproduced through runHealthTick with the default 30-minute threshold: observe web-everything/web-everything#7:stood-down every two minutes from minute 0 through 30, opening its episode. Pause health-watch while the daemon records an empty snapshot at minute 32 and the returned hold every two minutes from 34 through 64. Read those records together at minute 64. Although memory records the confirmed clearance and the returned hold's new 30-minute age, evaluation takes the breach branch before checking cleared. The result has no transitions, no notification plan, no closed history, and retains t
   - Claude's re-check: Tracing foldOperatorHolds on the claimed sequence: the minute-32 empty snapshot puts the subject in 'cleared', and the episode is still open so it isn't pruned. Holds at 34–64 restart 'first' at 34, so the age is 30 min. In 'evaluate', 'ageMs &gt;= threshold' is checked before 'cleared.has(subject)'. The breach branch wins, no clean result is emitted, and the old episode stays open with no close, no new episode and no notification. The existing test only covers a return still below threshold.

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
