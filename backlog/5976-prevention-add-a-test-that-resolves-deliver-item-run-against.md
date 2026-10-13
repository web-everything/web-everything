---
bornAs: xwic3jc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-run.mjs", "we:scripts/settings/codex.json", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/deliver-item-run.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a test that resolves deliver-item-run against DEFAULT_ROUTING_POLICY and asserts the effectiv… (from web-everything/web-everything#5068 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/deliver-item-run.mjs:193` — Add a test that resolves deliver-item-run against DEFAULT_ROUTING_POLICY and asserts the effective Codex build model/effort, or align the policy build entry with the route.
2. `we:scripts/settings/codex.json:1` — Add a one-line test that `readSettings().codex.modelByTask` deep-equals `CODEX_MODEL_BY_TASK_DEFAULT`, or ship the file empty.
3. `we:scripts/operations/review-dispatch.mjs:204` — Resolve lazily inside `reviewSeatRoutes`, or catch and fall back at module load. Add a test that sets an invalid `WE_CODEX_MODEL_BY_TASK` pair and imports the module.
4. `we:scripts/operations/review-dispatch.mjs:204` — Add a deterministic import-and-routing regression test that supplies an unsupported Codex pair while selecting only an unrelated provider and asserts that dispatch remains available.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5068@c78fa0daa84b714cc44274f4c4afd58710e8b858

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
