---
bornAs: xxfpvy3
kind: story
size: 5
priority: high
status: resolved
scope: ["we:.github/workflows/ci.yml", "we:.github/workflows/soak-replay-gate.yml", "we:scripts/lib/stack-review-while-open.mjs", "we:scripts/settings/stack.json", "we:scripts/conveyor/draft-promotion-rule.mjs", "we:scripts/conveyor/draft-promotion-loop.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Stacked PRs reviewed and fixed while their base PR is open (stack.reviewWhileBaseOpen)

GitHub-stacked PRs (base = another lane branch) sat as awaiting-base drafts: CI only ran for PRs into main, so they never went green, never promoted, never reviewed; stacks were reviewed serially. Run CI on PRs into lane/**, promote a stacked draft on its own green checks, review vs base (stack-aware review), fix in parallel when the top's change touches none of the base's files, and keep merge waiting for the base (fail-closed drain guard).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/stack-review-while-open.test.mjs` passes (fails on main: the module and workflow triggers do not exist).
- [A2] A stacked draft whose own required checks are green is promoted while its base is open; with `stack.reviewWhileBaseOpen` off it is refused `stacked-awaiting-base` (the old serial behaviour).
- [A3] Review vs base: the stack-aware review (#4729) finds the open base PR as the top's stack base; an accept is held while the base is open and carried forward after the restack on an identical net diff, else one re-review.
- [A4] Fix: bottom-first (#4655) holds a top only while BOTH are being fixed on shared files. The top is dispatched when (a) its base owes no fix this pass and holds no fix claim (round cap, needs-you, nothing owed), or (b) the top's own change touches none of the base's files. Replay of live #4715 (held 2026-10-10 12:39–15:03Z behind cap-exhausted #4708): all 10 held ticks dispatch under the new rule.
- [A5] Must refuse on error: the drain never merges a PR whose base is not the default branch; a `lane/*` base is held even when the default-branch read failed (fail closed).
- [A6] Live: one of #4750/#4757/#4759/#4770 is promoted and reviewed while its base is still open (daemon log + PR comment).

## Resolution

CI now runs on PRs into `lane/**` (we:.github/workflows/ci.yml, we:.github/workflows/soak-replay-gate.yml), so a stacked PR has its own required checks. Promotion (shared rule + tick pass) is gated on `stack.reviewWhileBaseOpen` (default on; `we:scripts/settings/stack.json`; env `WE_STACK_REVIEW_WHILE_BASE_OPEN`; source logged once per daemon). The review path is unchanged: a ready PR with green checks is reviewed, and the stack-aware review judges it against its base. The fix daemon holds a stacked top behind its base only while the base owes a fix or holds a live claim AND the top's own diff shares a file with the base's (unknown reads keep the hold). The drain's non-default-base arm is now fail-closed for `lane/*` bases.
