---
kind: task
status: active
scaffoldedBy: "parked-watch-skip"
dateScaffolded: "2026-11-20"
scope: ["we:scripts/lib/static-selection-edges.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Shadow static-edges accuracy gaps (AO S1 audit findings 3-8, waived)

Follow-up to lane/ao-s1-shadow-edges: string/template contents scanned as code, templates and regex literals opaque to the call scanner, execFile missing, CLI passes no alias map, deleted changed modules not marked partial, decision-invariance tests always use sensitive paths so shrink cases are untested.

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

## Duplicate admission

New card: follow-up accuracy gaps of the AO S1 shadow scanner, no existing card covers them

## Report-validation hardening (audit round 3 on the --measure report check)

1. Reject empty names and statuses outside the known vitest set (a clean sample can otherwise be recorded).
2. Establish full-run evidence: refuse interrupted, pending, partial-suite or stale reports (completeness or revision check).
3. Detect runtime errors through fields the installed vitest JSON reporter really emits.
4. Reject contradictory reports (a passed suite holding failed assertions).
5. Validate `--selected-json` and bind it to the diff, so extra test names cannot hide escapes.
Also: check the 512 KB cap before reading a file fully, and add shrink-mode (non-sensitive path) cases to the shadow on/off invariance tests.
