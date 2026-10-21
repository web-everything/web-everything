---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — A lint or standards rule that flags interpolation of error text into buildConflictFindingBody or… (from web-everything/web-everything#5405 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:309` — A lint or standards rule that flags interpolation of error text into `buildConflictFindingBody` or agent-prompt builders without a shared `quoteUntrusted()` helper (cap length, fence, strip control characters). Failing that, a review-lens note that external error text must be fenced when it reaches an agent.
2. `we:scripts/lib/merge-queue-enqueue.mjs:302` — Add CI regression cases in we:web-everything/scripts/lib/__tests__/merge-queue-enqueue.test.mjs named 'rejects post-mutation membership at a different head' and 'does not recover already-queued membership at a different head'; assert failure and no successful already-queued recovery respectively, and verify that removing each head comparison reddens its test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5405@b4166b2c9b5dec1df46140f3e2c23db5da079ffd

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
