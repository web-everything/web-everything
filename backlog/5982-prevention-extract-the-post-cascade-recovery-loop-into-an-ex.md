---
bornAs: xxe4n4r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Extract the post-cascade recovery loop into an exported function that takes injected skipped, prs… (from web-everything/web-everything#5037 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6562` — Extract the post-cascade recovery loop into an exported function that takes injected `skipped`, `prsByRepo` and `handleStaleMergeGate`, then test it behaviourally. A lint that flags source-text-regex tests of runtime behaviour would catch the class.
2. `we:scripts/lib/merge-queue-enqueue.mjs:351` — Add a deterministic parameterized regression test requiring mainCiGreen === true for manual-freeze refresh and asserting that refreshStalePr and the ledger writer remain uncalled otherwise.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5037@44c1d79534f811749cd2f1b9c966b9fe959e2f29

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
