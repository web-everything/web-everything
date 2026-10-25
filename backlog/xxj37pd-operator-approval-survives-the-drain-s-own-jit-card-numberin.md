---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Operator approval survives the drain's own JIT card-numbering push

#5608 (clear at 01:00Z, renumber push at 01:04Z, 2026-10-23 23:05 ET) and #5878 (2026-10-25 08:23 ET): the drain dequeues a human-enqueued PR to JIT-number its hash cards and says 're-enqueued after CI', but human-only PRs cannot be re-enqueued by the drain, and the clearance carry refuses when 'a later verdict or unknown comment stands'. Want: number cards BEFORE asking for the human enqueue, or carry the clearance/human enqueue across the numbering-only commit (verified by patch comparison), and make the carry ignore advisory or bot verdict comments that do not change review state. Also append one JSONL event (PR, old sha, new sha, cause: renumber/empty/rebase/main-merge) whenever an approval is lost to a new head so the coroner can count it (coroner 2026-10-20, card 372). Existing human-enqueue card 6249 covers the tool, not this loop.

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
