---
bornAs: x8qis8y
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-head-index.mjs", "we:scripts/lib/__tests__/review-head-index.test.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Review-head-index: retention change plus failed map publish can resurrect evicted verdicts (theoretical referral from #6378)

Deferred theoretical referral from #6378 (R639/R776, class: theoretical, inert module). In we:scripts/lib/review-head-index.mjs, when a writer lowers keepPerPr (20 to 3) and map publication fails after the log is accepted, rebuildKeep prefers the stale map's retention unless the reader supplies it, so evicted verdicts can become carryable again. Needs a changed-retention plus failed-publish recovery test, and persisting the accepted retention with the authoritative transaction.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/review-head-index.test.mjs` includes a changed-retention plus failed-map-publish case asserting evicted patches stay owed.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded beyond the referral.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: theoretical deferred referral; handled when the card is built.
2. **Truncated reads** — n/a: theoretical deferred referral; handled when the card is built.
3. **Shared state files** — n/a: theoretical deferred referral; handled when the card is built.
4. **Fail closed** — n/a: theoretical deferred referral; handled when the card is built.
5. **Identity scoping** — n/a: theoretical deferred referral; handled when the card is built.
6. **State over time** — n/a: theoretical deferred referral; handled when the card is built.
7. **Who wrote it** — n/a: theoretical deferred referral; handled when the card is built.
