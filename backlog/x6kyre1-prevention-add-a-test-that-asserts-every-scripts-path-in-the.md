---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs", "we:scripts/ci/__tests__/rerun-failed-once.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a test that asserts every ./scripts/... path in the spawned argv exists on disk, plus a contr… (from web-everything/web-everything#7366 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/rerun-failed-once.mjs:151` — Add a test that asserts every ./scripts/... path in the spawned argv exists on disk, plus a contract test that feeds real unit-json-reporter output to parseReport; add the reporter to the slice-2 must-fix card.
2. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:1` — A coverage-by-mutation gate for new fail-closed guards, or a table-driven refusal test generated from the list of throw sites in rerunOnce; file as a slice-2 prerequisite card.
3. `we:scripts/ci/rerun-failed-once.mjs:118` — Add a table-driven negative test that varies each verdict input (exit code, report, allowlist) independently. Longer term, a mutation-testing gate on scripts/ci.
4. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:1` — A repo convention or check that every `throw new Error` refusal branch in scripts/ci/*.mjs has a test asserting its message. Failing that, a review-lens checklist item.
5. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:43` — Parameterize negative tests over each field of a multi-field identity or count check.
6. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:40` — Extend we:settings-safe-direction.test.mjs to assert classify('ciUnitRerun','enabled') and ('ciUnitRerun','maxFiles') are 'safety', plus a tighten-direction case in the rerun test.
7. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:32` — Add a deterministic configuration-contract test that reads the owner JSON and asserts the documented defaults; this guard needs a future backlog item.
8. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:46` — Add table-driven negative contract tests varying each identity field and aggregate independently, with targeted mutation checks in writable CI; the additional guard needs a future backlog item.
9. `we:scripts/ci/rerun-failed-once.mjs:117` — Add deterministic negative cases for these contracts and a targeted mutation gate for the guarded conditions; this guard needs a future backlog item.
10. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:86` — Add a deterministic changed-path gate for the explicitly protected shared module during this slice; the guard needs a future backlog item.
11. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:85` — Add the named source-digest test to the deterministic test gate and require acceptance entries to reference their defending assertions.
12. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:47` — Gate changes with parameterized negative cases for every identity field and aggregate counter, plus targeted guard-removal mutation checks.
13. `we:scripts/ci/rerun-failed-once.mjs:118` — Add a deterministic retry-verdict matrix covering omitted, skipped, and newly failing assertions, and mutation-check the preservation predicate.
14. `we:scripts/ci/rerun-failed-once.mjs:133` — Add a deterministic boundary-test matrix with observable launch, deletion-order, output-location, and verdict assertions; require each documented refusal guarantee to map to a named case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7366@e68d55a45f9e008eadba457c04c06ca2eaf093e1

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
