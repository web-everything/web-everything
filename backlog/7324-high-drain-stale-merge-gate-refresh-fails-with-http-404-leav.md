---
bornAs: x1d0a8m
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/branch-sync.mjs", "we:scripts/pr-land.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# HIGH: drain stale merge-gate refresh fails with HTTP 404, leaving an accepted PR blocked

HIGH. 2026-10-28 08:00 ET. Drain's stale merge-gate refresh fails HTTP 404 on #6003 (judge sweep 07:56), so an accepted ready-to-merge PR stays BLOCKED on stale failing merge-gate run 40660142604 and cannot be queued. Trace the refresh call (wrong run/job id or endpoint), fix, prove on #6003.

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
