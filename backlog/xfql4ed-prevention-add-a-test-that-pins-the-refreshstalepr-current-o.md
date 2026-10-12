---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a test that pins the refreshStalePr 'current' outcome in the required-workflows handler, with… (from web-everything/web-everything#5021 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-queue-enqueue.mjs:118` — Add a test that pins the refreshStalePr 'current' outcome in the required-workflows handler, with an explicit fallback or a documented 'needs a person' reason. A lens note for refresh-path reviews is enough, since a gate cannot decide this.
2. `we:scripts/lib/merge-queue-enqueue.mjs:42` — Add a lint or test rule that any kill-switch or off-capable setting that gates a repo write treats an invalid value as 'off' (or surfaces it in JSON output too). Otherwise review a layered resolver's invalid-value path whenever its default is 'on'.
3. `we:scripts/lib/merge-queue-enqueue.mjs` — Add a deterministic failure-injection test to the required-workflows refresh suite and require a durable recovery reservation before mutating the branch; assert that persistence failure prevents refresh and subsequent passes cannot repeat a successful refresh.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5021@4b9f25ff1b48a53c355742c798e0f6c70fac5442

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
