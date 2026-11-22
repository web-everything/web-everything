---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7258 (head 322702c54)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7258 (reviewed head `322702c544034cb758c4b6fc415eeabbd06ed027`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-status-label.mjs:76` — (edge-case, degraded) Incomplete rollups can still produce ready-to-merge.
   - Scenario: An accepted, red-team-clear PR has 101 contexts: four required checks green, 96 advisory checks, and a pending rerun of test beyond the first 100. The real snapshot mapper marks the visible rollup rowsComplete:false, but derivePrStatusLabel returns ready-to-merge. Including the hidden pending row returns awaiting-ci. The daemon supplies this raw snapshot to the tagger, so readiness must wait for complete evidence.
   - Class: live-reproduced (basis: A Node probe using the checked-out mapGraphqlPr and derivePrStatusLabel reproduced both results without mocking either function.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pr-status-label.mjs:79` — (failing-input, degraded) A foreign-head aggregate can imply away the only required check.
   - Scenario: Set requiredChecks to ['integration'], the PR head to 40 a characters, and labels to review:accepted and red-team:clear. Supply only a COMPLETED/SUCCESS test row with headSha set to 40 b characters. withoutImpliedRequiredChecks removes integration before head validation; the empty required list then passes every(), producing ready-to-merge. It should return awaiting-ci because the aggregate proving integration belongs to another head.
   - Class: live-reproduced (basis: The checked-out predicate returned ready-to-merge for this input, while a foreign-head directly required test returned awaiting-ci. The shared review CI gate also rejected equivalent foreign-head aggregate evidence.)
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
