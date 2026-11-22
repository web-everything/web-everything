---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/conveyor/__tests__/audit-on-ready.test.mjs", "we:scripts/conveyor/audit-on-ready.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a tick-level test that stubs the PR reader and asserts the audit-owed line. Longer term, add… (from web-everything/web-everything#7325 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:1605` — Add a tick-level test that stubs the PR reader and asserts the audit-owed line. Longer term, add a lint or check that every new `run*Shadow` hook has a test referencing cliReviewTickOpts.
2. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:78` — Add a test that spies on the real write and dispatch modules. Alternatively, a static test could assert the hook's imports contain no label or comment writers.
3. `we:scripts/conveyor/audit-on-ready.mjs:40` — Have the gate return a machine-readable cause code and map unknown by code. Add a test for the unresolvable-sha case that expects owed-unknown.
4. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:69` — Have the canonical gate return a structured reason code, such as unreadable-evidence, so no message regex is needed. Add a table-driven test over the gate's refuse messages.
5. `we:scripts/conveyor/audit-on-ready.mjs:6` — Make the git runner an injectable parameter of defaultAuditCheck, then assert the timeout and killSignal options with a spy test. A lint rule requiring a timeout on execFileSync in the conveyor tick path would also catch it.
6. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:78` — Test by mocking child_process and fs write functions, or by asserting an exhaustive call log on injected gh and git runners. Add a mutation canary that must fail when a stub writer is wired in.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7325@dc8b4e25a69a7b24f9fd94b8463770364446bfbd

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
