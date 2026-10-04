---
bornAs: xr6uis3
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Operator hands-off switch: take one PR out of daemon handling instantly, and give it back

Operator request 2026-10-03: a quick way to take a PR out of all daemon handling for manual work, without merging a PR or editing code. Today the only partial lever is review-status:draft-withdrawn, which blocks draft promotion only; fixers, ci-heal, review dispatch, conflict watch and the drain still act. Add one label (e.g. conveyor:hands-off) honoured by every dispatcher before acting: we:scripts/conveyor/reconcile-core.mjs (all DISPATCH_KINDS), we:scripts/conveyor/parked-pr-conflict-watch.mjs, we:scripts/operations/promote-draft-pr-dispatch.mjs and the drain (we:scripts/merge-ai-prs.mjs). Setting it records who, when and why on the PR; an active fix claim is released cleanly first. Removing it hands the PR back. Settable from a CLI and from the WIP page. It never clears a review gate. Done when: a test per dispatcher shows it refuses with reason hands-off; a soak break proves a hands-off PR is untouched across a full pass and resumes after removal.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
