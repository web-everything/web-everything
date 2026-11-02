---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-main-quarantine.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# (R224) Quarantine "area" hold is a test-DIRECTORY prefix (testArea in we:scripts/lib/red-main-quarantine.mjs),

HIGH priority hint. - [HIGH] (R224) Quarantine "area" hold is a test-DIRECTORY prefix (testArea in we:scripts/lib/red-main-quarantine.mjs), so quarantining tests in we:scripts/__tests__/ or we:scripts/lib/__tests__/ holds nearly every PR (16:51 ET 10-29: #6039, #6058). Narrow to the quarantined test file + the file(s) it tests. Loosens a merge-safety guard → prepare (design + test plan + red-team) before build.   - UPDATE 17:03 ET: root cause of the "test-select" failures = selection over 100 tests → "operator review required" (overlay-main-sync-needs-you). A main merge into an overlay top touches many files, so selection balloons. Fix: select tests by the overlay's OWN changed files + conflict-resolved files (not the whole main delta), or run the big set on Forge; never page the operator for it.

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
