---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/ci/test-timings.json", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a test assertion that handled + deferred equals the number of PRs listed with no overlap. Alt… (from web-everything/web-everything#7330 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:317` — Add a test assertion that handled + deferred equals the number of PRs listed with no overlap. Alternatively, decrement or defer the count at the cap branch.
2. `we:scripts/ci/test-timings.json:2384` — Make the test-timings validator reject keys that do not match the test-file glob.
3. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1485` — Make defaultListBounced treat a result at the --limit as unreadable, so callers fail closed. Add a unit test pinning that. Better still, add a lint or check:standards rule that flags `gh pr list --limit N` results used as hold sets without a truncation check.
4. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs` — Extend this named unit test with an existing org/c cursor, assert it survives the listing error, and assert recovery resumes at that PR; retain it in the deterministic unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7330@0d03d21b2094f42c6f354652a6c6a783f249d9bf

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
