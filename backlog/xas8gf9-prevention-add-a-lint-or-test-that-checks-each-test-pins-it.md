---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/__tests__/rerun-failed-once.test.mjs", "we:scripts/ci/test-timings.json", "we:scripts/ci/rerun-failed-once.mjs", "we:scripts/lib/settings-safe-direction.mjs", "we:scripts/lib/__tests__/settings-registry.test.mjs", "we:scripts/lib/__tests__/settings-safe-direction.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a lint or test that checks each 'test pins it' phrase in a card Acceptance names an existing… (from web-everything/web-everything#7366 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:1` — Add a lint or test that checks each 'test pins it' phrase in a card Acceptance names an existing test file and case.
2. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:59` — Require each SAFE_DIRECTION entry to have a test pair, one loosening-refused and one tightening-applied, via a table-driven check in we:settings-safe-direction.test.mjs.
3. `we:scripts/ci/test-timings.json:408` — Have the check:standards timings rule reject placeholder values below a floor for tests that spawn subprocesses, or run refresh-timings in the same PR.
4. `we:scripts/ci/rerun-failed-once.mjs:131` — Add a table-driven 'each refusal guard has a test' case that varies firstExit and teardownFailed. Longer term, add a check:standards rule that every `throw new Error` in a fail-closed IO boundary function is named in a test, via a mutation or coverage threshold on this file.
5. `we:scripts/ci/rerun-failed-once.mjs:139` — Run a mutation or coverage gate on scripts/ci/*.mjs. Without that, add a guard-to-test checklist to the card template for fail-closed scripts.
6. `we:scripts/lib/settings-safe-direction.mjs:17` — Add a generic check:standards rule that every policy key with env overrides in a `ci*` settings file has a SAFE_DIRECTION entry and a test that exercises both the permitted and the refused env direction.
7. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs:29` — Add a deterministic lint rule rejecting direct process.env.TMPDIR arguments to temporary-path construction; use node:os tmpdir() instead.
8. `we:scripts/lib/__tests__/settings-registry.test.mjs:352` — Add we:web-everything/web-everything/scripts/ci/__tests__/rerun-failed-once.test.mjs::'shared policy-cascade source remains unchanged', asserting the expected source digest in CI.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7366@a20732c6b8f825ea7aa10977e53f19849118b6bc

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
