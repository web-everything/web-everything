---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs", "we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/conveyor/pr-stall-sweep.mjs", "we:scripts/lib/red-team-pending-watchdog.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Corrupt or mismatched status file for a pending head leaves the label un-reconciled and stalls the whole stal…

Flow-sim gap B-C3, class K4 (poison record halts a whole pass). Failing input: PR labels: red-team:pending (or blocked). Status file for HEAD exists but is not valid JSON (partial write by a non-atomic tool, disk full, manual edit) or has a different head/pr inside (identity mismatch). No retry marker. any tick after the corruption. Cited: we:scripts/lib/drain-red-team-evidence.mjs:488-491, we:scripts/conveyor/advisory-label-sweep.mjs:190, we:scripts/lib/review-red-team-on-skip.mjs:303-333, we:scripts/conveyor/pr-stall-sweep.mjs:286, we:scripts/lib/red-team-pending-watchdog.mjs:11-12. Soak-break sketch: stuck (silent, permanent for that head; plus fleet-wide stall-sweep no-op while the file exists)

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
