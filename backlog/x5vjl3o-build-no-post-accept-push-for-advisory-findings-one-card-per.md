---
kind: story
size: 5
parent: "5467"
status: open
scaffoldedBy: "post-accept-advisory"
dateScaffolded: "2026-11-01"
blockedBy: ["xu34pnv"]
scope:
  - "we:scripts/lib/review-loop-policy.mjs"
  - "we:scripts/operations/review-loop-cli.mjs"
  - "we:scripts/conveyor/advisory-fix-mark.mjs"
  - "we:scripts/lib/__tests__/review-loop-policy.test.mjs"
  - "we:scripts/operations/__tests__/review-loop-cli.test.mjs"
  - "we:scripts/conveyor/__tests__/advisory-fix-mark.test.mjs"
dateOpened: "2026-11-01"
tags: []
---


# Build: no post-accept push for advisory findings; one card per PR, shadow mode first

Mechanics for xu34pnv, ratified R370 and codified in `we:docs/agent/platform-decisions.md#post-accept-advisory-cards`. After an accept, findings are carded only when every impact is in `CARDABLE_IMPACTS` (`cosmetic`/`degraded`), no finding satisfies `requiresMandatoryReferral`, no review seat tags a security finding at any impact, and every `roundCardsRefusal` safety guard is clear. Any other impact (`broken`, `unrecoverable`, unstated or unknown), mandatory referral, security finding or fired guard forces a push regardless of confirmation status. The card must exist before the PR merges as accepted with no new head; failed filing parks the PR. The rule is a pure function in `we:scripts/lib/review-loop-policy.mjs`, next to the round budget of card 5471, reusing its impact split and safety guards rather than copying them. Factor the shared safety checks out of the current changes-only `roundCardsRefusal` gate so they also apply to a genuine accepted verdict; preserve the changes-only gate for existing round-budget callers, without fabricating a changes verdict for the post-accept path. K does not gate this rule. The setting is `review.postAcceptAdvisory.mode` (off | shadow | on) through the policy cascade, shadow first.

## Acceptance

- [A1] **Executable** — add the following named cases to the `post-accept advisory replay fixtures` block in `we:scripts/lib/__tests__/review-loop-policy.test.mjs`. Run from the WE repository root; the command must pass. Cases (g) and (h) also require the caller tests named below.

  ```sh
  npm run test:unit -- scripts/lib/__tests__/review-loop-policy.test.mjs
  ```

  - (a) `accepted cardable findings at any round produce one card without a push`: cosmetic/degraded findings with every guard clear, at rounds below and above K, give no push and one card with one numbered line per finding.
  - (b) `non-cardable impacts and security tags force a push without confirmation`: table-test broken, unrecoverable, unstated and unknown impacts, plus security-tagged findings at each impact including cosmetic/degraded, with and without confirmation. Each forces a push and no card-only merge.
  - (c) `unreadable policy evidence fails closed`: unknown impact, an unreadable ledger or setting, or a rule error forces a push.
  - (d) `off preserves current behaviour`: mode=off gives today's behaviour.
  - (e) `shadow records decisions without changing behaviour`: mode=shadow records the would-be card/push decision while retaining today's behaviour, including the refusal cases in (b) and (f).
  - (f) `mandatory referrals and every shared refusal guard force a push`: table-test `requiresMandatoryReferral`, human-required, pending referral, blocked referral and uncorroborated retirement separately on a genuine accepted verdict. Mix each with otherwise cardable findings and assert no card-only merge. Pin existing changes-only round-budget behaviour after shared-guard extraction.
  - (g) In both `we:scripts/operations/__tests__/review-loop-cli.test.mjs` and `we:scripts/conveyor/__tests__/advisory-fix-mark.test.mjs`, add caller tests `card filed before merge` and `filing failure parks the accepted PR`. Inject a deferred filer and assert no merge or new head before it succeeds, then one persisted card before merge eligibility. Table-test a throw, an explicit filing refusal and an incomplete result with no persisted card: each leaves the PR parked, with no merge or new head. Reach the real caller wiring with injected filing/merge IO; a pure decision fixture alone is insufficient.
  - (h) `verdict provenance alone controls cardability`: only the trusted review verdict supplies impact and security/referral metadata. Test a PR author claiming its own finding cardable, author-supplied overrides of broken/security/referral metadata, missing or unreadable verdict provenance, and finding text claiming cosmetic/broken/security status. Reject author overrides and fail closed on absent trusted evidence; varying text alone must never change the verdict-derived decision. Include newline, CR/U+2028, backticks, quotes, leading `--`, `..`, invisible/NFKC characters and concatenated payloads, copied as inert card data. Also add caller test `author input cannot override verdict provenance` in both caller suites from (g), exercising the actual verdict-input path rather than only preconstructed trusted facts.
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
4. **Fail closed** — an error in the rule or setting forces a push; card filing must succeed before merge eligibility, and any filing failure keeps the PR parked, never merges it silently (A1(c), (g)).
5. **Identity scoping** — the accept is read per PR from the ledger, bound to the reviewed head.
6. **State over time** — a new head pushed by anyone else after the accept voids the accept as today.
7. **Who wrote it** — only the trusted review verdict assigns impact and security/referral metadata; finding text cannot assign severity and the author of a PR cannot mark its own finding cardable (A1(h)).
8. **Ratified refusal gates** — mandatory referrals, security tags at any impact and every shared safety guard force a push even alongside cardable findings, without a confirmation requirement (A1(b), (f)).
