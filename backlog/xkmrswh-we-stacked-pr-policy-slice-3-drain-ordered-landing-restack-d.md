---
kind: story
size: 8
parent: "xejcrh1"
status: open
blockedBy: ["xcq5jb9"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/review-stack-base.mjs", "we:scripts/settings/pr-stack.json"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 3 - drain ordered landing, restack, delta re-review

Make the drain land a policy-stacked child only after its base, restack the child when the base head moves (stack.onBaseHeadMove), and re-review only the child delta. The hold marker moves only when the delta fingerprint is unchanged and the base's new commits touch none of the child's files. Ruled in xv85eqi.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/conveyor/__tests__/pr-stack-policy.test.mjs and we:scripts/__tests__/merge-ai-prs-stack-order.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `drain: a policy-stacked child is held until its base is proven landed, then lands`.
  - `drain: the base lands first when both are ready in the same pass`.
  - `restack: a moved base head restacks the child, bottom first, under the round cap`.
  - `re-review: after a restack only the child delta is re-reviewed, never the base's lines`.
  - `hold marker: re-pointed to the new base head only when the delta fingerprint is unchanged and the base's new commits touch no file of the child delta`.
  - `hold marker: left unmoved and the delta re-reviewed when the base's new commits touch a child file`.
  - `review:accepted is applied only at collapse through the net-diff carry (gate not weakened)`.
  - `onBaseHeadMove setting set to a different value changes the behaviour (not a constant)`.

## Non-goals

- [N1] Does not handle a closed or rejected base (slice 4) and does not change the proof-of-land gate itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — fingerprints and touched files come from git data, never from PR text.
2. **Truncated reads** — a truncated diff or file list means the marker is not moved and the delta is re-reviewed.
3. **Shared state files** — we:scripts/settings/pr-stack.json keeps its own keys; the stack settings file stays owned by slice 1.
4. **Fail closed** — an unknown base head, a failed restack or a missing gate holds the child.
5. **Identity scoping** — the relation counts only between trusted lane PRs of the same actor, as we:scripts/conveyor/review-stack-base.mjs already requires.
6. **State over time** — every base move re-evaluates the cell and the fingerprint at that moment.
7. **Who wrote it** — an automation's own comment never moves the hold marker.
