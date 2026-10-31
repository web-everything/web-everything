---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/review-timing-settings.mjs", "we:scripts/lib/review-fix-policy-settings.json"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "06649b999eb6a4ddceadd53808ed09b5d9ee6cf6"
tags: []
---

# Review starts before CI, fix pushes after CI (review.startBeforeCi / fix.pushAfterCi)

Add the review.startBeforeCi and fix.pushAfterCi settings so review runs in parallel with CI while a fix push waits for CI. Re-filed goal of card xw237s5, which PR 6084 did not deliver.

## Acceptance

- [A1] **Executable** — new tests for the two settings fail before and pass after.
- [A2] **Executable** — with both settings at their defaults, review/fix timing behaviour is unchanged (control test).

## Non-goals

- [N1] Not part of PR 6084 and not delivered by it; no state-machine work.
- [N2] No change to review verdict logic.

## Design

Re-files the goal of card xw237s5. Add two settings: `review.startBeforeCi` (start the review as soon as the PR head exists instead of waiting for CI green) and `fix.pushAfterCi` (a fix may be prepared while CI runs but is pushed only after CI for the current head completes). Read them through the existing settings modules `we:scripts/lib/review-timing-settings.mjs` and `we:scripts/lib/review-fix-policy-settings.json`, following their existing shape and validation. Results tie to head SHA, so a review started before CI is discarded if the head moves. The builder confirms the exact decision call sites by reading these modules' consumers.

## MVP

Musts: the two settings with defaults preserving today's behaviour, the gating in the review start and fix push decisions, tests. Out: changing defaults.

## Test plan

- Default settings: review start and fix push decisions identical to today.
- `review.startBeforeCi` on, CI pending: review starts; off: it waits.
- `fix.pushAfterCi` on, CI pending: push held; CI done for the same head: push allowed; head moved: held and re-evaluated.
- Invalid setting values fail closed to the default with a named reason.

## Proof plan

Dry-run on a live open PR with CI pending, before/after output of the start/push decision for both settings, recorded in the PR. Codex audit.

## Edge cases this change must handle

1. **Untrusted text** — n/a: settings are booleans validated by type.
2. **Truncated reads** — CI status reads use full pages; a truncated list is an error, not "no checks".
3. **Shared state files** — n/a: settings are read-only here.
4. **Fail closed** — unreadable CI status holds the fix push; unreadable setting uses the default.
5. **Identity scoping** — review and CI results are keyed repo + PR + head SHA.
6. **State over time** — head moves after review start: stale review discarded; repeat suppression across ticks.
7. **Who wrote it** — CI status trusted only from the required check source, not from comment text.

## Follow-ups

- Consider default-on after observed review/CI overlap savings.
