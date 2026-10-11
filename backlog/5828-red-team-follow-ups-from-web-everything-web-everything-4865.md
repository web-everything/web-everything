---
bornAs: xacdbzo
kind: story
size: 2
status: open
scope: ["we:scripts/lib/judge-spawn.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4865 (head 6cf5a69d9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4865 (reviewed head `6cf5a69d9d35af3717fa0c5e422786178199920e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/judge-spawn.mjs:901` — (edge-case, degraded) Retries bypass the panel's aggregate budget admission check.
   - Scenario: Call judgePanel with one juror, budget=1, maxTotalBudgetUsd=1 and one retry. If attempt 1 spends $0.80 before exiting with empty stdout, attempt 2 receives another full $1 budget. A read-only injected-spawn probe confirmed two distinct sessions each receiving --max-budget-usd 1; a successful second attempt reporting $0.80 produces totalBudgetUsd=1, totalCostUsd=0.8 and ok=true. The sequence can actually spend $1.60 against the admitted $1 ceiling, with the first attempt's spend invisible. Retry budgets must be included in panel admission or conservatively reserved from the existing ceiling.
   - Claude's re-check: The retry loop in judgeSpawn calls buildJudgeArgv with the same full 'budget' on every attempt. A failed attempt that exits with empty stdout returns no cost, so its spend is never recorded. Each retry can spend up to another full budget, so a juror can use up to (1+retries)×budget, and the first attempt's spend is not counted anywhere. The diff does not show judgePanel's admission check, but the per-attempt budget reset is visible.

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
