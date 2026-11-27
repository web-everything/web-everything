---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7567 (head f4c34877a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7567 (reviewed head `f4c34877a8f3be06dbfa414d3717e0da9144ed23`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/rearm-review.mjs:293` — (edge-case, degraded) Historical changes-requested reviews permanently block no-code evidence after approval
   - Scenario: Supply an otherwise authorized same-head resume with review:changes and formal reviews containing CHANGES_REQUESTED followed by APPROVED from the same reviewer. The paginated provider retains both historical records, so reviews.some rejects authorization and fix-run withholds the trailer. The check should evaluate the reviewer's current effective disposition rather than treating the superseded request as an active hold.
   - Class: correctness-in-normal-use (basis: An isolated probe of the actual authorization function returned allowed:true without a formal hold and allowed:false for the superseded-request sequence. The provider reads the full review history; unrelated authorization prerequisites were supplied as fixtures.)
   - Also class: coverage-or-style
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
