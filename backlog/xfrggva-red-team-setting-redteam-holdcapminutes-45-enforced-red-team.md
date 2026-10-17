---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/settings/drain-queue-safety.json"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.holdCapMinutes=45 enforced: red-team-pending past the cap goes to needs-you

Build after #5482 and #5480 land (they hold we:scripts/lib/drain-merge-strategy.mjs, we:scripts/lib/drain-queue-safety.mjs and we:scripts/settings/drain-queue-safety.json). The existing cap drain.redTeamPendingMaxMin=45 is not enforced: past the cap the drain only logs a health smell in we:scripts/lib/drain-merge-strategy.mjs and keeps holding silently; #5461 was held 111 min, #5486 held from 20:17Z. 30 hold episodes on 28 PRs in 23 h, 1,651 min held, median 33, p90 92.6, 5 over 60 min, 2 over 4 h. Spec: redTeam.holdCapMinutes = 45, ENFORCED. Find the existing cap setting and why it does not apply. When the red-team-pending hold passes the cap, the PR goes to needs-you (the existing feed) with how long it waited. It is NOT released to merge; the guard stays fail-closed. Test: cap passed -> needs-you, not merged. Operator 2026-10-17: Ok. Never weaken a hold. Tests first, run red, one per setting. A cascade setting with its source logged.

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
