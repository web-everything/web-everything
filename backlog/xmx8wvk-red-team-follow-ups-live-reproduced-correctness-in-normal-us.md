---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7258 (head f20fcdccb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7258 (reviewed head `f20fcdccbad94c133d352659befdaf7e64225276`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-status-label.mjs:79` — (edge-case, degraded) Implied requirements bypass the aggregate check's head validation
   - Scenario: Use a clean PR with review:accepted, red-team:clear, headRefOid equal to 40 a characters, requiredChecks=['integration'], and one COMPLETED/SUCCESS test check whose headSha is 40 b characters. withoutImpliedRequiredChecks removes integration before the aggregate's SHA is validated, leaving an empty required list. The PR receives ready-to-merge despite having only old-head CI evidence. It should remain awaiting-ci until a current-head integration check or aggregate succeeds.
   - Class: live-reproduced (basis: A read-only Node probe executed the checked-out requiredCiGreen predicate with the real implication helper. It returned true for the old-head aggregate satisfying integration, while the same old-head check directly required as test returned false.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pr-status-label.mjs:76` — (edge-case, degraded) A truncated rollup can hide a pending required-check rerun
   - Scenario: Use an accepted, red-team-clear PR requiring test. Supply rowsComplete=false and a 100-row statusCheckRollup containing a successful test plus 99 unrelated checks, with a newer pending test omitted beyond the connection limit. The predicate ignores the incomplete-evidence marker and reports green, producing ready-to-merge. Including the omitted pending row produces awaiting-ci. Incomplete evidence should retain awaiting-ci or trigger a complete required-check read.
   - Class: live-reproduced (basis: A read-only Node probe of the checked-out predicate returned true for the truncated 100-row snapshot and false for the complete 101-row snapshot. The repository's GraphQL mapper exposes rowsComplete=false for truncated connections, and its shared rollup helper explicitly documents the 100-context cap.)
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
