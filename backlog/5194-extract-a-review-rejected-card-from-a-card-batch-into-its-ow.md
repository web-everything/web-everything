---
bornAs: xuz8m83
kind: story
size: 5
parent: "4703"
status: open
blockedBy: ["5193"]
scope: ["we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/__tests__/card-batch-extract.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Extract a review-rejected card from a card batch into its own PR

The #4703 failure half. When a batch PR gets review:changes, reconcile routes it to extraction instead of the ordinary fix dispatch. One card is one file is one commit, so a finding that cites exactly one card file attributes deterministically. That card commit is cherry-picked onto its own standalone ref and opened as its own PR carrying the findings for the normal fix loop; the remaining cards are rebuilt onto a fresh batch ref from main (no force push), re-verified and re-sealed under a new PR; the old PR is closed with pointers; both manifests are updated and no approval is reused. A finding that cites no card file, or more than one, holds the batch for a human with the reason; nothing is guessed or silently dropped. Related open work: the one-finding-identity change in PR #4069.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/card-batch-extract.test.mjs and we:scripts/conveyor/__tests__/reconcile-core.test.mjs passes (strip the `we:` prefix to execute), with real git repos and a recording forge adapter.
2. **Must** — from a 3-card batch with a finding citing the middle card file: the standalone ref holds exactly that card commit on top of main; the rebuilt remainder ref holds the other two commits with byte-identical card files; both manifests list the right members; the old PR is closed with pointers to both new PRs.
3. **Must** — reconcile plans `card-batch-extract` (not `fix`) for a `lane/card-batch-*` PR labelled `review:changes`; any other PR still plans `fix` exactly as before.
4. **Must (refuse on error)** — a finding citing no card file, or two card files, holds the batch for a human with the reason, and nothing is extracted or dropped.
5. **Must** — no approval or verify carries over to either new head; no push is forced; a rerun of extraction after a crash produces no duplicate PR.
6. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] Attribution reads the review findings' file paths; one card = one file = one commit makes the mapping exact.
- [ ] Standalone PR opens parked `review:changes` with the findings, so the normal fix loop owns it.
- [ ] Remainder: cherry-pick survivors onto a fresh ref from main, then the seal sequence from the seal slice.
- [ ] Coordinate with open PR #4069 (one finding identity) if it lands first; it is not a blocker.
