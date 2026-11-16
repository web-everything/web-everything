---
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: []
---

# promote-draft-pr-dispatch reviewHoldOnlyRed must call decidePublish (review-hold v2 follow-up)

At we:scripts/conveyor/promote-draft-pr-dispatch.mjs:377, `reviewHoldOnlyRed` still trusts any red row named `review-gate`. Make it call `decidePublish` from we:scripts/lib/review-hold-io.mjs (review-hold v2) so only a proven review-gate hold counts as hold-only red. Deferred out of the v2 slice by design section 4.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- scripts/conveyor/__tests__/promote-draft-pr-dispatch*.test.mjs` includes a test where a forged red `review-gate` row with decidePublish false is NOT hold-only red.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded beyond changing the review-gate marker or workflow.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reuses decidePublish, which handles it.
2. **Truncated reads** — n/a: reuses decidePublish, which handles it.
3. **Shared state files** — n/a: reuses decidePublish, which handles it.
4. **Fail closed** — n/a: reuses decidePublish, which handles it.
5. **Identity scoping** — n/a: reuses decidePublish, which handles it.
6. **State over time** — n/a: reuses decidePublish, which handles it.
7. **Who wrote it** — n/a: reuses decidePublish, which handles it.
