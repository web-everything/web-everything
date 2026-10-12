---
bornAs: xyif25r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-ci.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs", "we:scripts/lib/__tests__/accept-carry-forward.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — A test that sets the drain carry switch off and asserts evaluatePrGates also refuses the carry. F… (from web-everything/web-everything#4962 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-ci.mjs:97` — A test that sets the drain carry switch off and asserts evaluatePrGates also refuses the carry. Failing that, a lens checklist item: any new consumer of a shared proof must honour the existing kill switch.
2. `we:scripts/lib/merge-gate-ci.mjs:98` — An integration test that runs evaluatePrGates without an injected proveCarry against a real temp git repo. Also derive mainRef from facts.defaultBranch.
3. `we:scripts/lib/accept-carry-forward.mjs:20` — When wiring headContribution into the callers, add a test that the re-stamp path requires a replay proof for the contribution tier.
4. `we:scripts/lib/accept-carry-forward.mjs:252` — Require verified replay evidence before contribution-tier acceptance and add a deterministic regression test using identical added/removed lines at different occurrences in one file; keep that test mandatory before wiring production callers.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4962@9a6b3b40f40b86e323294b88b915cbc9eac0894c

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
