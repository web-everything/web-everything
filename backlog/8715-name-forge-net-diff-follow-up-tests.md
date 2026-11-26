---
bornAs: xq7478t
kind: story
size: 1
status: open
dateOpened: "2026-11-25"
scope: ["we:backlog/8713-prove-safe-pure-test-renames-in-forge-net-diffs.md", "we:skills-src/drain/SKILL.md", "we:scripts/lib/__tests__/drain-api-reads.test.mjs", "we:scripts/__tests__/merge-ai-prs-forge-net-diff.test.mjs"]
tags: []
---

# Name forge net-diff follow-up tests

PR #7478's latest review deferred two advisory topics: the pure-rename follow-up card
lacks named planned tests for A1–A4 (raised by two lenses), and the drain skill's live
frontierui #53 acceptance has manual evidence without a named test. Keep those topics
separate from the pagination repair, as the review requests.

## Acceptance

- [A1] **Must** — map the rename card's A1 to `pure test rename matches real git tamper scan`,
  A2 to `rename proof binds both immutable endpoints and refuses incomplete metadata`,
  and A3 to `unsupported rename variants remain held`, planned in
  `we:scripts/lib/__tests__/drain-api-reads.test.mjs`.
- [A2] **Must** — map the rename card's A4 to `proven pure test rename delivers and missing
  mode-type proof parks`, planned in `we:scripts/__tests__/merge-ai-prs-forge-net-diff.test.mjs`.
  Names describe future coverage; do not claim the rename feature already exists.
- [A3] **Must** — give the frontierui #53 acceptance a named, explicitly opt-in live test
  `frontierui 53 pinned compare scores the recorded base and complete diff`, with the
  pinned head, base, eight files and 1091 diff lines documented in the drain skill.
  Keep live evidence distinct from hermetic fixtures and ordinary offline checks.

## Non-goals

- Do not implement rename admission or require a network call during the current repair.

## Duplicate admission

The existing rename card owns feature implementation. This card records only the
review-requested acceptance/test mapping and live-proof naming follow-up, combining
the two lenses' duplicate rename observation.
