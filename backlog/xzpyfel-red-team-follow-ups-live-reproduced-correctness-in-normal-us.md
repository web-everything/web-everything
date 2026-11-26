---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7532 (head 4e5de6bc5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7532 (reviewed head `4e5de6bc50ee4adee525d1e0aae3156f5807e2bb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/fix-run.mjs:860` — (failing-input, degraded) Truncated PR bodies still count as model misses
   - Scenario: Supply a normal review repair with a short finding and PR body consisting of 8,000 characters followed by a required instruction. renderPrContext drops that instruction, but inputGaps only checks the finding length. A no-change agent result records cause: model; two such results count toward escalation. This launcher-truncated input should record cause: input.
   - Class: live-reproduced (basis: Executed runFixCli with injected external IO. The captured prompt omitted the required instruction and contained the truncation marker, while the recorded outcome was no-change/model. consecutiveUnproductiveOnHead counted two identical results as two model misses.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2193` — (edge-case, degraded) The answer-read budget repeatedly starves later answered PRs
   - Scenario: Present five PRs with answered unknown-cause parks in stable order. Let an active build overlap only PRs 1–4. Those four consume every answer read before the scope gate refuses them. PR 5 exhausts the read budget and remains fix-loop-parked on every pass despite having an operator answer and disjoint scope. Subsequent passes should make progress on its pending answer.
   - Class: live-reproduced (basis: Two consecutive probes through the actual planner, dispatcher and scope filter each refused PRs 1–4 for scope-overlap and PR 5 for fix-loop-parked. Processing PR 5 alone launched it successfully; answer releases are not persisted and the read budget restarts at the same candidates.)
   - Also class: theoretical-race
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
