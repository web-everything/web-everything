---
bornAs: x7da8bt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a unit test for run-level /attempts/N URLs asserting the attempt-specific jobs endpoint is us… (from web-everything/web-everything#4074 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:1469` — Add a unit test for run-level `/attempts/N` URLs asserting the attempt-specific jobs endpoint is used, or that the resolver refuses when N is not the latest attempt.
2. `we:scripts/conveyor/reconcile-pass.mjs:1466` — Add a shared `safeDiag()` helper that strips control characters and caps length. Require it for any externally sourced value placed in a refusal `why`, enforced by a check:standards rule or a lint on Error templates in conveyor refusal paths.
3. `we:scripts/conveyor/reconcile-pass.mjs:1466` — Add a deterministic parameterized test crossing app identity with valid job URLs, run-level URLs, and invalid URLs; require non-Actions rejection independently of URL validity.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4074@97b26c2bbbe3a872e03eaa531c6aa37e292655d7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
