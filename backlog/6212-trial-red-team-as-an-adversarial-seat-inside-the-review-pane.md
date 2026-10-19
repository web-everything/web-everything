---
bornAs: xbg6csc
kind: story
size: 5
status: open
blockedBy: ["6209", "6211", "6207", "6206"]
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Trial: red team as an adversarial seat inside the review panel (redTeam.timing=panel-seat)

Priority: top (operator 2026-10-17). Operator 2026-10-17: Ok. Blocked by the four red-team settings cards (6209, 6211, 6207, 6206). Option (d) of the red-team analysis: run the red team as one more adversarial seat in the review panel so its breaks arrive in round 1, with one finding table and one ruling path. Numbers: 51% of red-team calls wasted (736 of 1,444, excluding infra); 39% of accepted heads (422 of 1,090) have a confirmed break; time added after accept is median 2.1 min, p90 3.7 min; 324 non-accept heads discard the red team output including real breaks; 62 send-backs (median 121 min wait each) and 28 round-cap handovers. Expected: no added wait, no discards, no stale reruns, fewer send-back loops, retires the separate red-team gate and its round cap. Risk: loses the independence of attacking the accepted state; the Claude re-check must still confirm. Trial behind redTeam.timing=panel-seat, default unchanged; measure against the baseline above.

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
