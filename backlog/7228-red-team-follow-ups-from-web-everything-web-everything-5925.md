---
bornAs: xatlizb
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5925 (head 9c8e4c5f8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5925 (reviewed head `9c8e4c5f83f31d9c5b901bf76e2e1e13151eb988`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/orphan-fix-round.mjs:100` — (edge-case, degraded) A valid ruling posted after the verdict within the same timestamp second never triggers recovery.
   - Scenario: Provide an ordered thread containing a blocked-referral changes verdict followed by a valid operator not-real ruling, both with createdAt=2026-10-25T13:00:00Z, on the unchanged head with review:changes + review:human and no fix round. The referral gate reports open=0, ruled=1, pending=[], blocked=[], but the planner returns none because the ruling is excluded from the strictly-later 'after' array. Moving only the ruling timestamp forward one second produces rearm. GitHub timestamps can tie within a second; recovery should recognize the later comment using thread order or another ordering signa
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
