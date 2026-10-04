---
bornAs: xz9pvrt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4880-a-codex-mandatory-seat-on-every-claude-authored-pr-so-one-bl.md", "we:backlog/4874-one-pure-review-need-core-risk-tier-author-providers-and-too.md", "we:backlog/4973-route-native-jurors.md", "we:backlog/4088-route-overlay-overlapping-pr-reviews-to-a-main-only-checkout.md", "we:backlog/4374-route-review-seats-by-risk-to-antigravity-claude-sonnet-4-6.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add to the card's Must-on-error list: decline unless crossProvider is exactly met or not-required. Add… (from chalbert/web-everything#3779 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4880-a-codex-mandatory-seat-on-every-claude-authored-pr-so-one-bl.md:47` — Add to the card's Must-on-error list: decline unless `crossProvider` is exactly `met` or `not-required`. Add an undefined-and-garbage test case. Write the independence check as an allow-list in the label writer as well.
2. `we:backlog/4874-one-pure-review-need-core-risk-tier-author-providers-and-too.md:52` — Skip the seat only when the commit author identity or the PR's recorded authoring actor (the authored-by-actor stamp) corroborates Codex. Treat trailer-only evidence as unknown. Add a forged-trailer test.
3. `we:backlog/4973-route-native-jurors.md:37` — Derive `changedFiles` from the pinned diff in the payload, or cap the tier at Sonnet unless the list is verified.
4. `we:backlog/4088-route-overlay-overlapping-pr-reviews-to-a-main-only-checkout.md:50` — Require that `prFiles` use the same net-diff resolver as review-pr (`netChangedFiles`). Treat a degraded or unscored basis as `park-human`. Add that case to Must-on-error.
5. `we:backlog/4374-route-review-seats-by-risk-to-antigravity-claude-sonnet-4-6.md` — Add a parameterized we:review-pr.test.mjs gate covering invalid or missing tiers combined with both true and false tool flags, requiring Opus with tools in every invalid-tier case.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3779@bc672e9cc3179ac9037e15fc43862bbe368d1de0

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
