---
bornAs: xdux0fc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/job-record.mjs", "we:scripts/lib/daemon-jobs.mjs", "we:scripts/lib/__tests__/daemon-item-tasks.test.mjs", "we:scripts/lib/daemon-item-tasks.mjs", "we:scripts/operations/__tests__/job-record.test.mjs", "we:scripts/lib/__tests__/daemon-jobs.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test table of real GitHub slugs (.github, a_b, mixed case) and decide explicitly whether to… (from web-everything/web-everything#5933 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/job-record.mjs:36` — Add a test table of real GitHub slugs (`.github`, `a_b`, mixed case) and decide explicitly whether to normalise or refuse. Better, add a shared repo-slug validator used by all callers.
2. `we:scripts/lib/daemon-jobs.mjs:225` — Skip terminal records before validating them. Quarantine an invalid task record (exclude it from admission and surface it) instead of throwing. Add a test that a bad record does not block unrelated admissions.
3. `we:scripts/lib/__tests__/daemon-item-tasks.test.mjs:1` — Run a mutation or passthrough check that every `enqueueItemTask` option is asserted on the persisted record.
4. `we:scripts/lib/daemon-item-tasks.mjs:163` — Give each refusal branch its own test that asserts the specific message, e.g. `inputs: ['pull.head.sha','open'], fences: ['pull.head.sha','open']` with only `pull.head.sha` read. A mutation-testing pass over the plan validators would catch the whole class.
5. `we:scripts/lib/daemon-item-tasks.mjs:107` — Add a case where `snapshot.identity` is `{repo, item, extra: 1}` and expect `deferred-read`. A mutation gate on boolean sub-clauses would also catch this.
6. `we:scripts/lib/daemon-item-tasks.mjs:48` — Validate standard-layer leaves before merging and add a deterministic parameterized test pairing an invalid standard value with valid higher-priority overrides.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5933@617ebffc1990dca65d2a1be3189b99a825514def

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
