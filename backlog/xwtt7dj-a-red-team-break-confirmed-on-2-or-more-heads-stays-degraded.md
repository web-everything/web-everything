---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A red-team break confirmed on 2 or more heads stays "degraded, card-queued"

[held entry 354] (coroner 2026-10-14, held) A red-team break confirmed on 2 or more heads stays "degraded, card-queued". #5243: repo-name collision and 2099 timestamp confirmed on e5ed9cb7, 245c4054 and 54e662a1 (6175160074, 6179714612, 6183441755), never fixed. #5245: full-stem URL break on a503a16b, b96021d1 and b9ec26fa (~10.5h). Fix idea: the gate keys breaks by file and claim. A second confirmation on a later head upgrades the break to a send-back, and the card-landing job dedups. Evidence: above. Scope: we:scripts/operations/red-team-gate-apply.mjs, we:review-extra-seats.mjs. Size 2. | [held entry 355] (coroner 2026-10-14, held) Past the round cap, a confirmed broken or security break gets no fixer, only an operator turn. "NOT sent back" at the cap: #5187 (3 breaks, rounds 5/6/7), #5245 (3), #5237 (4), #5233 (2); 7 red-team round-cap stops in the window. Card 344 removes rebase rounds, but real content rounds still hit the cap. Fix idea: a confirmed break of impact broken or security grants one bonus fixer round on the stronger-model rung, then escalates with the break pre-ruled. Evidence: comments 6175746382, 6178135459, 6179755450 (#5187), 6177574121 (#5245). Scope: we:scripts/lib/jury-core.mjs round cap, we:red-team-gate-apply.mjs. Size 3.

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
