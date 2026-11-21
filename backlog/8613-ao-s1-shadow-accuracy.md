---
bornAs: xzdb5ur
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

- [A1] **Executable** — run from the WE checkout:

```sh
node scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run scripts/lib/__tests__/static-selection-edges.test.mjs scripts/readiness/__tests__/test-selection.test.mjs
```

The hoisted-path, computed-load, full-mode and division regressions fail before S1b. Unknown evidence must widen; dependency/config/statute changes must retain full shadow mode.

## Non-goals

- [N1] S1b never changes real selection, [we:scripts/lib/related-test-selection.mjs](../scripts/lib/related-test-selection.mjs), alias configuration, workflows or enforcement. Report completeness/revision validation and selected-report diff binding below remain outside this slice; this card stays active pending that residual work and the repository close-out gate.

## Edge cases this change must handle

1. **Untrusted text** — scan source as data; computed loads and ambiguous slashes mark the file unknown. No source is executed.
2. **Truncated reads** — reject above 512 KB before reading; oversized/unreadable evidence is unknown and widens reach; only changed files make it partial, never an empty clean selection.
3. **Shared state files** — existing config/dependency/statute classifiers force full shadow mode; no policy list is duplicated.
4. **Fail closed** — unknown tests always selected, unknown sources widen reverse reach, listing failure/throw means full shadow; no test-list truncation.
5. **Identity scoping** — ROOT containment and symlink guards precede reads; measure rows carry HEAD/base.
6. **State over time** — deleted changed modules remain edge targets and mark evidence partial; untracked/deleted non-tests reaching no test force full.
7. **Who wrote it** — only local tracked source is evidence; measurements remain diagnostic and cannot alter the real mode/tests/complete.

## S1b validation

Tests-first on main `c18c5279`: the static-edge suite reported 27 failures and 84 passes before implementation, including the primary hoisted-path regression. Initial S1b scoped run: **147/147 tests passed**, including the 30-main-diff import-only superset check, all four weakening mutations (each reached an AssertionError), shrink-path invariance, and the 1 MB/400 KB timing bounds. The existing alias map API remains available; CLI alias configuration is unchanged because current aliases target the external FUI sibling. The report-validation residuals below prevent resolving the entire card in this slice.

## Duplicate admission

New card: follow-up accuracy gaps of the AO S1 shadow scanner, no existing card covers them

## Report-validation hardening (audit round 3 on the --measure report check)

1. Reject empty names and statuses outside the known vitest set (a clean sample can otherwise be recorded).
2. Establish full-run evidence: refuse interrupted, pending, partial-suite or stale reports (completeness or revision check).
3. Detect runtime errors through fields the installed vitest JSON reporter really emits.
4. Reject contradictory reports (a passed suite holding failed assertions).
5. Validate `--selected-json` and bind it to the diff, so extra test names cannot hide escapes.
Also: check the 512 KB cap before reading a file fully, and add shrink-mode (non-sensitive path) cases to the shadow on/off invariance tests.

Pre-review filesystem-boundary coverage: the named `readShadowFile rejects an oversized stat before reading source bytes` test supplies oversized metadata and asserts zero source reads, then proves an exactly-at-cap file reaches the reader. Removing only the pre-read size guard made this test fail with “expected [Function] to throw an error”; the guard was restored before final validation.


## S1b replay measurement follow-up

Preserve full-mode escalation and conservative `shadowEscaped`, while returning sorted `staticTests` before escalation (including unknown widening). Measure samples record `staticTestCount`/`totalTests` and `shadowEscapedStatic`; missing static evidence remains null. These diagnostics never choose tests. Unchanged oversized/unreadable modules are unknown and listed with reasons without marking the graph partial; changed oversized/unreadable/deleted modules still do. The 30-commit superset replay now checks pure static reach instead of the escalated all-tests set.

Tests-first follow-up: the admitted scoped run failed **9 tests** (145 passed) before implementation, covering static reach/count/escape evidence and changed versus unchanged bounds. Post-implementation admitted scoped run: **153 passed, 1 failed**; the sole failure was an outdated fixture expectation for the newly listed unknown `we:vitest.config.ts`. After correcting that expectation, the admitted focused classifier rerun passed **5/5**. All 154 distinct scoped cases are verified across those runs, including the pure-static 30-commit replay, conservative/static escape comparisons, and serialized real-decision invariance. The related-selector SHA-256 remains `2ffa9cc250e7a89624dfa0152e41d73d8d38ccce3c96070012cf1aa194c2c0f3`.
