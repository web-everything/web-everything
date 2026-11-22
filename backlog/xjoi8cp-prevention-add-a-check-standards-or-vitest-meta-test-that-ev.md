---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/change-evidence/record.mjs", "we:scripts/lib/__tests__/change-evidence-writer.test.mjs", "we:scripts/lib/change-evidence/__tests__/record.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a check:standards or vitest meta-test that every boolean guard field in we:merge-policy.json… (from web-everything/web-everything#7319 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/change-evidence/record.mjs` — Add a check:standards or vitest meta-test that every boolean guard field in we:merge-policy.json (separationOfDuties, required, and similar) has a test fixture that flips it. Alternatively, require a mutation-probe list in the PR for each guard line.
2. `we:scripts/lib/change-evidence/record.mjs` — Parametrize policy-exclusion tests over `Object.keys(config.clauses)` instead of a hard-coded list, so a new or differently-shaped clause cannot be skipped.
3. `we:scripts/lib/__tests__/change-evidence-writer.test.mjs` — Gate budget-scaling changes with a deterministic multi-merge boundary test whose required reads exceed the fixed allowance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7319@bd1543100acc6592427443a7b0375778d5da3b7b

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
