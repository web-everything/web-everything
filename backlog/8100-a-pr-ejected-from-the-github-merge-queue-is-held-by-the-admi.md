---
bornAs: xlv5uzx
kind: story
size: 5
status: open
related: ["7843"]
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/operations/pr-ownership.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A PR ejected from the GitHub merge queue is held by the admission guard with a log line only; no actor owns t…

Flow-sim gap R5c-G3, class K10 (hold without a settler). Failing input: PR ready-to-merge + review:accepted, own `test` green, was enqueued, then GitHub removed it from the queue (RemovedFromMergeQueueEvent reason failed_checks for the merge-group commit, or merge_conflict). (a) failed_checks on head H after the single infra retry was spent or retry evidence not met; (b) three merge_conflict ejecti… Cited: we:scripts/lib/drain-queue-safety.mjs:81-87, we:scripts/lib/drain-queue-safety.mjs:66-68, we:scripts/merge-ai-prs.mjs:4875-4877, we:scripts/lib/enqueue-on-event.mjs:318, we:scripts/lib/drain-merge-strategy.mjs:284-287. Soak-break sketch: Fixture: timeline with RemovedFromMergeQueueEvent failed_checks on head H (twice, or once plus a re-add), PR labelled accepted+ready-to-merge, checks green. Action: run the drain pass 5 times plus reconcile planning. Assertion that fails today: after N passes…

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
