---
bornAs: xi9sda9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-gate.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/lib/__tests__/resource-gate.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a sampler contract test, or compute freePct from vm_stat (free + inactive + speculative) or f… (from web-everything/web-everything#4799 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-gate.mjs:232` — Add a sampler contract test, or compute `freePct` from `vm_stat` (free + inactive + speculative) or from `memory_pressure`. Add a lint-style check that any new gate threshold input names its measurement source.
2. `we:scripts/lib/resource-gate.mjs:232` — Add a table-driven decideFixCap test that nulls every signal one at a time and all at once, and require at least one known signal before any raise. Filing it as a backlog item for a unit-test rule is enough.
3. `we:scripts/readiness/heavy-admission.mjs` — Add a deterministic test in we:scripts/readiness/__tests__/heavy-admission.test.mjs that disables both isUnderTest checks, supplies conflicting default and override preference files, and asserts that shared-pool capacity comes from the default file while a private pool honors the override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4799@c0cdc7f6cdcb366efdd73c2a391b02e6847235f8

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
