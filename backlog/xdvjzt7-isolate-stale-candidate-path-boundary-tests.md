---
kind: story
status: open
size: 2
dateOpened: "2026-10-27"
scope: ["we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs"]
tags: [daemon, testing, prevention]
---

# Isolate stale candidate path boundary tests

Give each path-boundary test otherwise eligible ownership evidence so unrelated checks cannot hide a removed guard. Assert that rejected candidates trigger no unlock, Git removal, or filesystem deletion.

## Source

Prevention owed by simplicity/COVERAGE in the advisory on [PR #5998](https://github.com/web-everything/web-everything/pull/5998), 2026-10-27 19:27:04 UTC, head `6a7130abebe6d24459d058c1cbef9b9f5b936d5f`. The reviewer confirmed fixture masking but could not execute mutation verification. This card records that limitation rather than asserting a mutation result.

## Design

Replace the grouped fixtures in `we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs` with individually named cases for another clone prefix, a nested path, an unlocked worktree, and a non-candidate name. Each uses a matching same-host lease, a valid dead-owner pid and candidate suffix wherever those are not the boundary being tested. For the nested-path case, use an otherwise valid own-clone candidate basename under a child directory, so the parent-directory check is the sole rejection. Include an eligible sibling as a positive control.

## Acceptance

- Each fixture states its single disqualifying condition and asserts no `worktree unlock`, no `worktree remove`, and no injected filesystem removal.
- The clone-prefix case retains a suffix that parses if only the prefix check is removed, with lease evidence explicitly matching the candidate and parsed pid.
- Removing only the parent-directory guard makes its named test fail; removing only the clone-prefix guard makes its named test fail.
- The eligible control reclaims successfully, proving that the shared ownership fixture reaches the reclaim branch.

## Test and proof plan

Use the approved targeted mutation mechanism for the two path guards in `we:scripts/lib/daemon-rebuild/candidate.mjs`; do not manually disable a safety guard in a repair checkout. Save the failing test names for each mutation and the green unmodified-source gate result. The strengthened negative tests are deliberate non-regression pins and may pass before implementation; passing against unmodified source alone is not proof they isolate the boundaries.

## Non-goals

Changing production path guards or reclamation policy. In particular, this item does not reopen the repeated failed-Git-removal finding ruled `not-real` on PR #5998.
