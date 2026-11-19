---
bornAs: x6rzv7h
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The drain red-main hold ignores the quarantine

HIGH priority hint. ## (held 2026-10-27 17:03 ET, HIGH) The drain red-main hold ignores the quarantine While main is red the drain holds every non-main-fix PR (red-main-hold), even when every failing test on main is quarantined. That defeats R157: quarantine exists to let merging resume while the fix is built. Live 15:53-17:xx ET today: 6006/5998/5994/6015/6016 were held behind the gate-config timeout. Fix: red-main-hold lifts when every failing test file in the latest main run is covered by an active quarantine entry. merge-gate red-main-freeze gets the same rule. Prove it on the next red main. - Related: the safety net removed the manual hook-wiring quarantine with why=main-green after ONE green main run, though the test was flapping (red again 14:50 ET). Removal should need N consecutive greens of that file (setting), or #6015 merged.

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
