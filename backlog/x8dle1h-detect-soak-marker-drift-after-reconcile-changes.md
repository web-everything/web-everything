---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/conveyor/soak/"]
dateOpened: "2026-11-21"
tags: []
---

# Detect soak marker drift after reconcile changes

PR #7263's 2026-11-21 correctness review found that a valid rewrite of `latestHeadReview` left the R618 soak detector and omission manifest pinned to removed source lines. The scenario still passed, but `fixPresent` selected `it.fails`, making CI fail. A sibling fix-pushed guard marker had also drifted.

## Acceptance

- When a diff touches `scripts/conveyor/reconcile-core.mjs`, a `check:standards` gate evaluates every registered soak break's `fixPresent(root)` on the changed tree and reports each missing fix by break id and source path.
- The gate distinguishes deliberately absent fixes from regressions in previously present fixes, using explicit baseline evidence; an unreadable baseline or detector must produce an actionable failure rather than silently skip a break.
- Pin the PR #7263 case: removing either chronology guard marker, or changing the fix-pushed condition without updating its marker, fails the gate before review.

## Test and proof plan

Use isolated source roots to exercise present, stale, absent, and throwing detectors. Show the stale R618 fixture red and the synchronized fixture green. Include the full `scripts/conveyor/soak/breaks` run in the affected-test plan for reconcile changes, using `vitest.soak.config.ts`.

## Related work

Cards 5292, 7024, and 7112 address detector independence and pre-fix truthfulness. This card covers drift detection on a changed production tree before review.

Review prevention key: web-everything/web-everything#7263@b680c2923:correctness
