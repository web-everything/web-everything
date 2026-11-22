---
kind: story
size: 2
status: open
scope: ["we:docs/agent/testing.md"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7357 (head 828d843f0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7357 (reviewed head `828d843f05691b28a47829d4677f23058f04b623`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:docs/agent/testing.md:6353` — (edge-case, degraded) Bot ownership leaves soak timings permanently stale until a unit-test gate fails
   - Scenario: Add 75 untimed soak test files, either together or across successive PRs. The precheck accepts them, but we:scripts/conveyor/soak/__tests__/shard-files.test.mjs requires measured timings for more than 80% of soak files. The current inventory becomes 383 measured files out of 479, or 79.958%, failing that test. The documented bot cannot recover: we:refresh-timings.mjs updates only unit timings and preserves soak unchanged. Following the new ownership instructions should keep timing entries nonblocking; soak refresh or the remaining coverage requirement must accommodate untimed additions.
   - Class: correctness-in-normal-use (basis: A read-only Node probe used the actual inventory and timing map plus 75 synthetic paths: precheck returned true while the existing coverage assertion failed. The bot's unit-update formatter preserved all 75 missing soak entries. No files were created and a full modified-checkout CI run was not performed.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
