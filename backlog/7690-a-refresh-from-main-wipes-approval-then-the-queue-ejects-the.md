---
bornAs: x660sj8
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# A refresh from main wipes approval, then the queue ejects the PR and its batch-mates

MED priority hint. ## (held 2026-10-27 14:56 ET) A refresh from main wipes approval, then the queue ejects the PR and its batch-mates #5999/#5990/#5969 were rebased or update-branched from main after acceptance. The new head reset review, so ready-to-merge dropped. Queued groups then failed merge-gate on candidate-label ("no ready-to-merge label"), and batch-mates #5970/#5936 were ejected too (18:02-18:34Z). Fix: (1) a clean refresh (merge of main, no conflict, same net diff) carries the acceptance forward (reviewed-diff marker equality). (2) The drain/merge-gate refuses to keep a PR without ready-to-merge in a group, and dequeues it alone before the group runs, so it never poisons batch-mates.

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
