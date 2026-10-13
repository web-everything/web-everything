---
bornAs: xwc42kb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs"]
dateOpened: "2026-10-07"
preparedDate: "2026-10-13"
preparedAgainstSha: "e1320124c6b7f6d01e0fe99f5462c6dcd15e9b1d"
tags: []
---

# Prevention — Add table rows where head is omitted and coverage.headSha is missing, and decide the intended out… (from web-everything/web-everything#4328 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-merge-gate.mjs:319` — Add table rows where `head` is omitted and `coverage.headSha` is missing, and decide the intended outcome: hold or defer when the head can't be verified, at least under `ledger`. A pure-function property test, 'clear implies head and coverage both present and equal', would also guard this class.
2. `we:scripts/lib/pr-merge-gate.mjs:322` — Add table rows for a clearing ledger with head=null and with coverage.headSha absent, in `both` and `ledger` modes. Make the code treat a missing sha as a defer or a hold, whichever the statute prefers. A deterministic option is a lint or test rule that every gate predicate has an 'unknown input' row.
3. `we:scripts/lib/pr-merge-gate.mjs:317` — Add a test row with a malformed `holds` value and wrap the unreadable check with `Array.isArray`, treating anything else as unreadable.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4328@6471e698edcab06fd605a9e34c3b8c2d082f58ab

## Progress

- Prepared 2026-10-13. Premise check: no commit delivers this (`git log --grep=5303` shows only the JIT-numbering and filer commits); the gap is live.
- Drift corrected: the card's old citations (lines 317, 319, 322) now sit at `ledgerVerdict` (`we:scripts/lib/pr-merge-gate.mjs:371-382`; the unreadable check is lines 372-374, the sha compare is 379-381). The scope's test path (`we:scripts/lib/__tests__/pr-merge-gate.test.mjs`) does not exist; the real file is `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs`, so `scope:` is corrected to it. Goal unchanged.

## Design

`ledgerVerdict` (`we:scripts/lib/pr-merge-gate.mjs:371`) decides head coverage with `if (sha && covered && sha !== covered)` (line 380). When `head` is null/empty or `folded.current.coverage.headSha` is missing, the condition is false and the function falls through to `clear: true` (line 381). So an unverifiable head clears under `both` (when labels clear) and under `ledger`. Fix: after the holds/clears checks, if `sha` or `covered` is not a non-empty string, return `{ clear: false, defer: true, reason: 'ledger-head-unverifiable: ...' }`. Defer, not hold, matches the existing rule in the `decideLedgerGate` JSDoc (line 349 area): "unreadable is a hold, never empty". `labels` mode is untouched (ledger never consulted, line 362).

Second guard: `ledgerVerdict` reads `derived.holds ?? []` then `.some(...)` (line 373). A non-array `holds` (string, object, number) either throws (`.some` not a function) or iterates wrongly, breaking the "never throws" contract. Normalize: `const holds = Array.isArray(derived.holds) ? derived.holds : null`; if `derived.holds` is present but not an array, treat as unreadable (defer, reason `ledger-unreadable`). Absent `holds` (undefined) stays `[]` as today.

`holds: null` is treated as unreadable too (today `?? []` makes it clear); only `undefined` stays `[]`. The array check goes BEFORE the `.some` call, which is where a string/object/number `holds` throws today.

Caller impact: `we:scripts/lib/drain-ledger-shadow.mjs:117` passes `head` from the verdict and `authority: 'ledger'`. A clearing row with no head or no `coverage.headSha` now reports `unreadable` (was agree/disagree), so shadow stats shift, and legacy rows lacking `headSha` show as unreadable. That also makes its `!covered` transient branch (about line 127) unreachable for the no-coverage case; the build must keep or drop that tolerance explicitly and say which in `## Progress`. `we:scripts/lib/merge-gate-ci.mjs:268` maps defer to fail-closed and a real PR always has `headRefOid`, so it is safe.

Third guard: add a property-style test, "clear implies head and coverage both present and equal", looping a grid of head/coverage shapes and asserting no ledger/both result with `clear: true` unless both shas are equal non-empty strings.

## MVP

Musts:
1. Missing/empty `head` or missing `coverage.headSha` defers under `both` and `ledger` (with a distinct reason).
2. Non-array `holds` defers as unreadable and never throws.
3. Table rows + the property test in `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs`.

Out of scope (Follow-ups): a repo-wide lint that every gate predicate has an "unknown input" table row; auditing the other callers' (`we:scripts/lib/merge-gate-ci.mjs:268`, `we:scripts/lib/drain-ledger-shadow.mjs:117`) own head sourcing.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the function reads only sha strings and hold codes; the reason string interpolates `sha`/`covered`, so the new reason must NOT embed them when they are non-strings (use fixed text for the missing case).
2. **Truncated reads** — n/a: pure function, no `gh`/`git` reads.
3. **Shared state files** — n/a: no files written.
4. **Fail closed** — the core of this change: missing head, missing coverage sha, and malformed `holds` all defer with a named reason; never clear, never throw.
5. **Identity scoping** — head compare stays exact-string; accepts both `{sha}` and bare string forms; a non-string `sha` (number, object) counts as missing.
6. **State over time** — n/a: stateless; a stale coverage sha is already handled by the existing mismatch row.
7. **Who wrote it** — n/a: no trust-granting author/source is read here.

## Test plan

New rows in `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs` (each fails RED today because the code clears):
- `head: null` + clearing ledger, `both` + labels clear: expects `clear:false, defer:true`. Today: clears.
- Same for `ledger`.
- `head: {}` / `head: ''` (empty sha): defer in `both` and `ledger`.
- clearing ledger with `coverage.headSha` absent, `both` and `ledger`: defer.
- `labels` authority with the same inputs still follows labels (regression pin).
- malformed `holds` (`'x'`, `{}`, `5`, `null`) under `both` and `ledger`: defer, and the call is wrapped in `expect(() => ...).not.toThrow()`. Today the first three throw in `.some`; `null` clears.
- Property test (the grid MUST include head null/empty and coverage missing, or it is green today): over a grid of head x headSha values, `clear:true` implies both present and equal.
- Existing rows (equal sha clears, mismatch holds) must stay green.

## Proof plan

Before/after CLI probe from the lane: `node -e` importing `decideLedgerGate` and printing the result for three inputs separately (head null with coverage present; head present with `coverage.headSha` absent; both absent), each with `{derived: clear, labelsClear: true, authority: 'ledger'}` — before: `clear:true`; after: `clear:false, defer:true`. Run vitest on `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs` red before, green after. Also run `we:scripts/lib/__tests__/merge-gate-ci.test.mjs` and `drain-ledger-shadow` tests to show callers still pass.

## Follow-ups

- Lint/test rule that every gate predicate has an "unknown input" row (card item 2's deterministic option).
- Audit that `we:scripts/lib/merge-gate-ci.mjs` and `we:scripts/lib/drain-ledger-shadow.mjs` always pass a real head, so the new defer is not reached in the live path.

## Done when

1. **Executable** — vitest on `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs` fails before this lands (missing-head and malformed-holds rows) and passes after.
