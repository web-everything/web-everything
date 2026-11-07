---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/orphan-claim-release.mjs", "we:scripts/backlog-stranded-sweep.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/operations/build-dispatch-hold-route-land.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A revert of a merged PR retracts nothing - delivery proof stays 'merged', the card stays resolved, and a re-o…

Flow-sim gap R8a-G6, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: PR #P (head lane/4459-foo) merged and card 4459 resolved. PR #R reverts it and merges. Operator re-opens card 4459 (status:open) and a session claims it (status:active), then dies; claim older than 48h. orphan-claim-release pass (and the stranded sweep) Cited: we:scripts/conveyor/orphan-claim-release.mjs:398, we:scripts/conveyor/orphan-claim-release.mjs:201, we:scripts/backlog-stranded-sweep.mjs:219-237, we:scripts/merge-ai-prs.mjs:7635, we:scripts/operations/build-dispatch-hold-route-land.mjs:151. Soak-break sketch: Fixture: mergedPrs = [#P matching card 4459], a later merged revert PR titled 'Revert 'WE #4459: foo'', card 4459 active and 3 days old, other signals empty. Action: classifyOrphan. Assert (fails today): verdict act:true (delivery retracted by the revert); to…

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
