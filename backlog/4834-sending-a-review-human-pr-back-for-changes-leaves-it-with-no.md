---
bornAs: xis0x3v
kind: story
size: 2
status: open

dateOpened: "2026-10-01"
tags: []
---

# Sending a review:human PR back for changes leaves it with no contradictory label pair, so the fixer picks it up

Live case 2026-10-01: PR #3215 carries review:changes AND review:human after the operator said "send back"; the review daemon logs "hold-reconcile FLAGGED contradictory review:changes,review:human — not auto-resolved (unsupported-pair)" every tick, so no fixer is ever dispatched and the PR sits. Fix: we:scripts/review-set-label.mjs --to=changes on a review:human PR removes review:human (the human ceremony is re-required on the next pass by the escalation scoring), and the hold reconciler resolves an existing changes+human pair the same way (changes wins). Replay #3215.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-11-20)

The build-dispatch daemon held #4834 with:

> worker-declined: Not prepared: #4834 — could-not-prepare. The proposed removal conflicts with the explicit human-hold invariant in 'we:scripts/review-set-label.mjs:725' and its test in 'we:scripts/__tests__/review-set-label.test.mjs:237'. Meanwhile, 'we:scripts/conveyor/reconcile-core.mjs:3088' already provides an operator-send-back fix route that retains the hold. The unresolved choice is whether to preserve that hold and repair any remaining dispatch gap, or authorize removing it and relying on later escalation to restore it. No files changed or stamped. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
