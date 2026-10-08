---
bornAs: xb5oxpa
kind: story
size: 8
status: open
scope: ["we:scripts/operations/perf-snapshot.mjs", "we:scripts/operations/perf-snapshot-io.mjs", "we:scripts/operations/perf-velocity.mjs", "we:scripts/operations/perf-velocity-io.mjs", "we:scripts/operations/__tests__/perf-velocity.test.mjs", "we:scripts/operations/__tests__/perf-velocity-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Velocity in perf-snapshot: points per day/hour (real vs estimated-from-brief), PRs merged per hour code vs card-only

Held card 129 (operator 2026-10-07: yes to points for all items). Add velocity to perf-snapshot: story points resolved per day and per hour (ET) detected through bornAs and JIT x<hash> to NNN renames; PRs merged per hour split code vs card-only (ci-card-only definition). Backfill from 2026-10-05: estimate a Fibonacci size from the PR body for merged PRs with no sized card, stored with source estimated-from-brief in a file beside snapshots.jsonl, calibrated first on PRs with sized cards (mean absolute error and bias reported). The snapshot diff labels real vs estimated points/day and points/hour.

## Done when

1. **Executable** - `npx vitest run we:scripts/operations/__tests__/perf-velocity.test.mjs` fails on main (no module) and passes after, including the case where a card born `x<hash>` is renamed to `NNN` at land and still counts once.
2. **Velocity metrics** - a snapshot row carries `velocity.points.*` (real and estimated, labelled by `source`) and `velocity.prs.*` per hour, code vs card-only; the diff prints each with its label.
3. **Backfill** - `perf-estimates.jsonl` beside `snapshots.jsonl` holds one `estimated-from-brief` row per unsized merged PR since 2026-10-05, computed once; a calibration run on sized-card PRs reports mean absolute error and bias.

## Edge cases this change must handle

1. **Untrusted text** - PR bodies go to the model on stdin only, truncated, with a forced JSON schema; the answer is clamped to a Fibonacci value.
2. **Truncated reads** - an unreadable git log yields no velocity metrics and a note, never zeros.
3. **Shared state files** - the estimates file is append-only; a PR already present is skipped.
4. **Fail closed** - a model failure or budget kill leaves that PR unestimated; it is never guessed.
5. **Identity scoping** - a card is one identity across its `x<hash>` and `NNN` names (bornAs / rename), counted once.
6. **State over time** - a card reopened and re-resolved counts at its first resolve.
7. **Who wrote it** - estimates carry `source: "estimated-from-brief"` and are never summed into real points.
