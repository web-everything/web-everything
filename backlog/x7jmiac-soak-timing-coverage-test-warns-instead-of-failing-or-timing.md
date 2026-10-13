---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/soak/__tests__/shard-files.test.mjs", "we:scripts/ci/shard-assign.mjs", "we:scripts/ci/test-timings.json"]
dateOpened: "2026-10-13"
tags: []
---

# Soak timing-coverage test warns instead of failing, or timings record themselves

Card 272 part 1 (operator-approved, filed not built, 2026-10-13). The soak shard test we:scripts/conveyor/soak/__tests__/shard-files.test.mjs ('the stored timings cover most break files', threshold 0.8) fails any PR that adds a new soak break without a stored timing in we:scripts/ci/test-timings.json. Live: PR #5045 went red at 0.796875 and drew four fixers. A missing timing only costs shard balance (we:scripts/conveyor/soak/shard-files.mjs falls back to the median), so it should not block a PR. Options: make the coverage check warn rather than fail, or record soak timings automatically (e.g. a main-only CI step that refreshes we:scripts/ci/test-timings.json). Part 2 (stale-base refresh before a fixer) ships separately as ciHeal.staleBaseRefreshFirst.

## Acceptance

- [A1] **Executable** — add one soak break file with no stored timing so coverage drops below 0.8; `npm run test:unit -- we:scripts/conveyor/soak/__tests__/shard-files.test.mjs` fails before and passes after (warning printed, or the timing recorded).
- [A2] **Must** — a break file that is still assigned to no shard (lost) keeps failing hard; only missing timings are loosened.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change how shards are balanced or the stale-base refresh (card 272 part 2, `ciHeal.staleBaseRefreshFirst`).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads only repo files (timings JSON, break file names).
2. **Truncated reads** — an unparseable timings file still fails the test (that is a real defect, not a missing entry).
3. **Shared state files** — if timings are auto-recorded, only a main-branch CI job writes we:scripts/ci/test-timings.json, never PR runs, so PRs never conflict on it.
4. **Fail closed** — a lost (unassigned) break file still fails; only coverage below the threshold becomes a warning.
5. **Identity scoping** — n/a: no per-user or per-repo state.
6. **State over time** — coverage drifts down as breaks are added; the warning names the files without timings so the drift stays visible.
7. **Who wrote it** — n/a: no authored markers are read.
