---
kind: story
size: 5
parent: "5467"
status: open
scaffoldedBy: "post-accept-advisory"
dateScaffolded: "2026-11-01"
blockedBy: ["xu34pnv"]
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/conveyor/advisory-fix-mark.mjs"]
dateOpened: "2026-11-01"
tags: []
---


# Build: no post-accept push for advisory findings; one card per PR, shadow mode first

Mechanics for the decision filed as xu34pnv. After an accept, a finding that is not a confirmed `broken` or `unrecoverable` one (or a confirmed security finding) is carded, not pushed. The PR merges as accepted with no new head, so no full review is re-armed. The rule is a pure function in `we:scripts/lib/review-loop-policy.mjs`, next to the round budget of card 5471 and reusing its `CARDABLE_IMPACTS` split. The setting is `review.postAcceptAdvisory.mode` (off | shadow | on) through the policy cascade. Blocked until the decision is ratified; the defaults below may change with the ruling.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/review-loop-policy.test.mjs` passes a `post-accept advisory replay fixtures` block: (a) accept + only cosmetic/degraded findings gives no push and one card with one numbered line per finding; (b) a confirmed broken, unrecoverable or confirmed security finding forces a push; (c) an unknown impact or unreadable setting forces a push (fail closed); (d) mode=off gives today's behaviour; (e) mode=shadow changes nothing and records the would-be decision.
- [A2] Shadow mode writes one ledger row per accepted PR: `wouldCard`, `wouldPush`, and the loops that followed. A report prints the counts and the count of shadow-carded findings later confirmed broken.
- [A3] Each carded finding is counted, with the cards' later fix rate, so card debt is visible (same counter as 5471 A3).
- [A4] **Proof** — replay the review ledgers of PRs #6158, #6033 and #6141 (5 to 13 loops each, 29% of all review loops together): the replay shows how many loops the rule removes. Then on one live accepted PR with advisory findings: before, a post-accept push and a full re-review; after, a card and no new head.

## Non-goals

- [N1] No change to the round cap, the round budget K, or `healDeltaReview` (card 5472).
- [N2] No self-accept by a fixer; the rule acts on review verdicts only.
- [N3] No change to CI or the drain's live re-check.

## Edge cases this change must handle

1. **Untrusted text** — finding text is copied into the card as data, never parsed for severity.
2. **Truncated reads** — an unreadable ledger or unknown impact means push (today's behaviour).
3. **Shared state files** — cards go through `file-item`; the count goes through the existing ledger writer.
4. **Fail closed** — any error in the rule, the setting or the filing keeps today's behaviour; a failed card filing keeps the PR parked, never merges it silently.
5. **Identity scoping** — the accept is read per PR from the ledger, bound to the reviewed head.
6. **State over time** — a new head pushed by anyone else after the accept voids the accept as today.
7. **Who wrote it** — only the review verdict assigns impact; the author of a PR cannot mark its own finding cardable.
