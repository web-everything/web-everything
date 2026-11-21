---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7258 (head 4751c1f9b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7258 (reviewed head `4751c1f9b83d08e616f7a176b88aba37b6e7336f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-status-label.mjs:76` — (edge-case, degraded) Truncated check rollups can still produce status:ready-to-merge.
   - Scenario: An accepted, red-team-clear PR has rowsComplete:false and 100 visible checks: successful test, smoke, daemon-soak, soak-replay-gate, plus 96 unrelated checks. A newer IN_PROGRESS test rerun is hidden on the next page. The daemon passes this raw snapshot to the tagger, and requiredCiGreen ignores its incompleteness, producing ready-to-merge. Including the hidden rerun produces awaiting-ci. Incomplete evidence should withhold readiness until the remaining checks are read.
   - Class: live-reproduced (basis: Executed the production derivePrStatusLabel module in a read-only Node VM with unrelated queue/advisory dependencies stubbed to neutral results. The truncated fixture returned ready-to-merge; adding the hidden pending rerun returned awaiting-ci. we:review-daemon.mjs:935 passes the raw snapshot to the tagger, independently of planner hydration.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
