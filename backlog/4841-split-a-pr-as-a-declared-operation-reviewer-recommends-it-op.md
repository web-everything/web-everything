---
bornAs: xjms2lt
kind: epic
parent: "4376"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: PD-PR ships; then add the one-click split action to the PR rung."
dateParked: "2026-11-22"
dateOpened: "2026-10-01"
tags: []
---

# Split a PR as a declared operation: reviewer recommends it, operator confirms with one button in Plateau, AI drivers call the same operation

Operator, 2026-10-01, after PR #3311 was split by hand-built scripts: a split should be a first-class option. (1) A reviewer verdict can be "split recommended", naming the parts to keep and the parts to move out by area and file, with the findings each moved part must carry (the review-loop addition already queued with card 4689). (2) Plateau shows that recommendation on the PR with a Confirm split button (plus edit and decline); the click is the operator decision, recorded on the PR. (3) One declared operation, split-pr in we:scripts/operations/, does the work the same way whether Plateau or an AI driver calls it: take the fix lock as a scope-change draft, have a worker keep the core and restore the moved parts to main, fix findings in the kept part, file the follow-up card with the moved findings as acceptance, take the PR files from git (not the GitHub file list, which stops at 100), verify, push fast-forward only, re-arm review, release the lock, and comment. Live lessons from the #3311 run to build in: a stood-down fixer must free the PR at once (card 4897); a fixture change needed for a safer default is allowed when assertions stay unchanged; a no-change worker run must not trigger a full re-verify.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: PD-PR ships; then add the one-click split action to the PR rung.
