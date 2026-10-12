---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4914 (head e4931727e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4914 (reviewed head `e4931727e2ae74dd475c1a1057955ef6be72ac3b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/mechanical-round-cap.mjs:418` — (edge-case, degraded) Advancing the base retroactively refunds a real repair round and reopens an exhausted fixer budget
   - Scenario: Complete five repair rounds: each repair commit F_i descends from the previous PR head M_(i-1), is merged back with --no-ff as M_i, and is followed by a trusted re-arm. Add another PR-only commit H and a review bounce with findings. Initially, readRoundCommits marks all five merges as mergesPrWork=true; the planner refuses with cap-exhausted, attempts=5. Now advance the base to include F_5, without changing H, comments, or author dates. The current base..head range excludes F_5 and M_1 through M_4. M_5 remains, but its repair parent is now classified as upstream and its clean tree causes merge
   - Claude's re-check: Once the base contains F_5, M_5's parents (M_4, F_5) both fall outside the base..head range, so the PR-work clause is false. M_5's tree is git's clean merge of those parents, so reproducesCleanMerge is true and mergesPrWork=false. Rounds 1–4 have no commits in range and stay spent, while round 5 becomes mechanical and is refunded. Result: real=4 instead of 5, and roundAttempts uses that value in place of the durable count, so the planner dispatches a fix instead of refusing at the cap. The trigger (base absorbing a PR repair commit) is unusual, but the code mishandles it as described.

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
