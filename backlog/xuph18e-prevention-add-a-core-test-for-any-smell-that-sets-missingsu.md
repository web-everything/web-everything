---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells/daemon-held-on-last-good.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-held-on-last-good.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a core test for any smell that sets missingSubjectsUnknown. It should require a documented bo… (from web-everything/web-everything#7590 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-smells/daemon-held-on-last-good.mjs:45` — Add a core test for any smell that sets missingSubjectsUnknown. It should require a documented bounded-retention path (age cap or explicit removal signal). Add it to the check:standards soak or contract tests.
2. `we:scripts/conveyor/health-smells/daemon-held-on-last-good.mjs:97` — Add a test with `failed: 'a\x1b[31mb\x00c'` that asserts `failedChecks` contains no C0 or C1 control characters. Longer term, add a notification-sink rule that every free-text measure field passes through one shared sanitiser, enforced by a check:standards rule.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7590@7bd5b613345ec5fd0e5ac81ff8eb3ec308884634

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
