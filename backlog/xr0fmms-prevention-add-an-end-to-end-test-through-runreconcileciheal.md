---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/lib/codeql-gate.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/lib/__tests__/codeql-gate.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add an end-to-end test through runReconcileCiHealDispatch. Longer term, a standards rule that eve… (from web-everything/web-everything#4378 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:431` — Add an end-to-end test through `runReconcileCiHealDispatch`. Longer term, a standards rule that every new `reason` value needs a test that goes from plan row to sink.
2. `we:scripts/lib/codeql-gate.mjs:39` — Make `isCodeQLFailed` call `failedCodeQLCheck`, or add a parity test over a fixture matrix of rollup shapes.
3. `we:scripts/lib/codeql-gate.mjs:125` — Test the empty-alerts, no-error case and word the brief accordingly ("no failure annotations found; check the run log").

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4378@6bb6bafdafb3a3f71e5545900a127311a18572b4

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
