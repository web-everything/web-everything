---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a test fixture for a job-op object with a missing job block. Better, classify foreign JSON by… (from web-everything/web-everything#4796 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-jobs-runtime.mjs:98` — Add a test fixture for a job-`op` object with a missing `job` block. Better, classify foreign JSON by the positive shape (`isPlainObject` and not a job `op`) so the rule fails closed for anything that looks like a job.
2. `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:65` — A custom test lint rule that flags test names containing absolute side-effect claims ('never deletes', 'leaves untouched') when the test body contains no filesystem assertions (e.g., `existsSync`) or mock validations.
3. `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:52` — A PR template write-gate that requires every explicit clause in a prose guarantee (like 'a primitive') to be paired with a named test case, or a formal Test Plan section.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4796@0378db7a2adab22f5e19bb2c60547c302d556f37

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
