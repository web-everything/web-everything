---
kind: story
size: 3
status: open
dateOpened: "2026-11-19"
tags: []
---

# Merge driver: auto-resolve we:scripts/ci/test-timings.json conflicts so they never block overlay adoption

Every lane that adds a test entry edits the same sorted JSON file, so two lanes conflict on adjacent lines. On 2026-11-19 the review daemon dropped the `lane/redteam-probe-cap-m1` overlay ("overlay-conflict-dropped") for this reason, and the probe-cap fix could not be adopted until a manual merge. The established rule is that the resolution is always the union of both sides. This item makes that automatic: a git merge driver for we:scripts/ci/test-timings.json (union of keys, same ordering), used by lane merges and by the overlay rebuild, so this file never blocks adoption.

## Acceptance

- [A1] **Executable** — a test merges two branches that add different keys to we:scripts/ci/test-timings.json and gets the union with no conflict; a key edited differently on both sides takes the larger number and logs it; invalid JSON on either side refuses (no silent merge).

## Non-goals

- [N1] n/a: other conflicting files keep today's handling.

## Edge cases this change must handle

1. **Untrusted text** — n/a: numbers and test paths only.
2. **Truncated reads** — a side that does not parse refuses the merge.
3. **Shared state files** — the driver writes only the merged file, atomically.
4. **Fail closed** — any doubt leaves the conflict for a person; it never guesses.
5. **Identity scoping** — n/a: no identities.
6. **State over time** — n/a: pure function of the two sides and the base.
7. **Who wrote it** — n/a: no authorship is trusted.

## Duplicate admission

test-timings conflicts dropped the lane/redteam-probe-cap-m1 overlay on 2026-11-19 (overlay-conflict-dropped); no card covers an automatic union merge
