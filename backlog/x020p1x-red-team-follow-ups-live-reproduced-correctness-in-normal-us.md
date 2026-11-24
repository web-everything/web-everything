---
kind: story
size: 2
status: open
scope: ["we:src/delivery/delivery-model.ts"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from plateauapp/plateau-app#232 (head 497932594)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#232 (reviewed head `497932594fa65a0695cd429104c34deac528451d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:src/delivery/delivery-model.ts:19` — (edge-case, degraded) Dotted step IDs incorrectly match their parent step
   - Scenario: Using the real fixture, supply an open review:pending PR with headRefName 'lane/human-PD1.S1.1' and a running worker whose description is 'Implement PD1.S1.1'. Both PD1 and PD1.S1.1 display that PR and worker, and the sole review chip points to PD1. The regex treats the dot as a boundary. These references should match the complete step ID PD1.S1.1 without also matching PD1.
   - Class: live-reproduced (basis: Reproduced in memory with the real fixture, actual model and view, and FrontierUI blocks under happy-dom. Observed duplicate attribution and the incorrect review-chip destination.)
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
