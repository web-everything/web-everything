---
bornAs: x0jknsk
kind: story
size: 3
status: open
related: ["6941"]
scope: ["we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/pr-land.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Card-batch state keyed to a batch PR number never checks that PR's state: closing the collecting batch PR unm…

Flow-sim gap R5a-G5, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: Collecting card batch state file (<stateDir>/<repo>-<kind>.json) with state.pr = P (draft, review-status:draft-withdrawn). An operator or daemon closes P unmerged.' 'More cards are admitted; the seal tick (sealDueBatches, called from we:health-watch.mjs:54) runs publishBatch. Cited: we:scripts/operations/card-batch-io.mjs:144-192, we:scripts/operations/card-batch-seal-io.mjs:73-78, we:scripts/operations/card-batch-seal-io.mjs:96-98, we:scripts/operations/card-batch-seal-io.mjs:253-254, we:scripts/operations/card-batch-seal-io.mjs:176-188. Soak-break sketch: Fixture: batch state with pr=9, sealed step before 'ready', gh stub: pr view reports state CLOSED isDraft true, pr ready exits 1. Action: publishBatch. Assert: batch is marked abandoned/retired (or reopened) and no new open-pr call is issued. Fails today: thr…

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
