---
bornAs: xni2w15
kind: story
size: 1
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Review re-stamp uses the contribution carry tier (headContribution)

The requested headContribution wiring is present in this checkout: the drain supplies its SHA-bound diff as contribution input and the re-stamp coverage check supplies headContribution. Existing regressions exercise contribution-preserving rebases and changed contributions.

## Acceptance

- [A1] `t=we:scripts/__tests__/review-set-label.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — Existing regression at line 2715 proves a contribution-matching rebase preserves human clearance and a subsequent source repair does not; retain the forged-contribution refusal at line 2801 and real-git changed-input cases at line 3801. These are closure evidence, not a new failing-before implementation criterion.

## Non-goals

- [N1] No weaker acceptance tier, automatic human clearance or new review authority. No HTTP endpoint is introduced; body-size caps, rate limits and CSRF are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Ignore forged clearance/digest markers from untrusted authors even if a contribution hash matches.
2. **Truncated reads** — Unreadable or incomplete review/thread/diff evidence must refuse carry; never stamp an unproven head.
3. **Shared state files** — Keep comment/label writes with the existing review writer; preparation adds no local shared-state format.
4. **Fail closed** — Changed source, tests, documentation, config or data must not retain contribution-equivalent clearance; preserve standing-review refusals.
5. **Identity scoping** — Bind coverage to the PR repo and exact head used to compute the diff; do not stamp a later head.
6. **State over time** — A later changes-requested review blocks re-stamp; unchanged contribution must not erase newer holds.
7. **Who wrote it** — Carry the trusted original clearance actor; a drain re-stamp is not a new independent review.

## Grounding

- we:scripts/merge-ai-prs.mjs:850 assigns headContribution from the SHA-bound diff.
- we:scripts/review-set-label.mjs:812 passes acceptedContribution and headContribution to coverage; line 1659 invokes it for restamp.
- we:scripts/__tests__/review-set-label.test.mjs:2715 covers contribution carry and subsequent change; line 3801 covers source/test/docs/config/data changes.

## Open questions

STALE: the named headContribution wiring is present. Should this card be closed as already shipped? The historical #4879/#4958/#4857 references do not establish unresolved prerequisite cards for this now-present wiring.
