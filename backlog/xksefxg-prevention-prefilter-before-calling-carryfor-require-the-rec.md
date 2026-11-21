---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/canonical-audit-gate.mjs", "we:scripts/ci/test-timings.json", "we:scripts/lib/main-merge-carry.mjs", "we:scripts/operations/__tests__/canonical-audit-gate.test.mjs", "we:scripts/lib/__tests__/main-merge-carry.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Prefilter before calling carryFor: require the record to be fingerprinted with a matching live fi… (from web-everything/web-everything#7279 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/canonical-audit-gate.mjs:186` — Prefilter before calling `carryFor`: require the record to be fingerprinted with a matching live fingerprint, and compute the live fingerprint once instead of per head. Add a bounded-exec-count test using a 500-record log. A script gate that counts `exec` calls in gate tests would catch this class.
2. `we:scripts/ci/test-timings.json:1487` — A check:standards rule comparing new entries in we:scripts/ci/test-timings.json against measured runtime, or generating the entry by a script rather than by hand.
3. `we:scripts/lib/main-merge-carry.mjs:14` — Add a graft-file and commit-graph tamper test to we:canonical-audit-main-merge-carry.test.mjs. Longer term, add a check:standards rule that requires each env or -c hardening key in we:scripts/lib/main-merge-carry.mjs to be named in a test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7279@4c8560e21f8dbce614086c954cf3fcf339fab496

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
