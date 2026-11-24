---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/resource-pool.test.mjs", "we:scripts/lib/resource-pool-io.mjs", "we:scripts/operations/run.mjs", "we:scripts/lib/__tests__/resource-pool-io.test.mjs", "we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a registry-wiring test that resolves every op with a finish sink through we:scripts/operation… (from web-everything/web-everything#7385 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/resource-pool.test.mjs:1` — Add a registry-wiring test that resolves every op with a `finish` sink through we:scripts/operations/run.mjs and asserts its sink or finish binding is present. Alternatively, add a lint that flags an op whose module exports a finishX that we:scripts/operations/run.mjs does not reference.
2. `we:scripts/lib/resource-pool-io.mjs:280` — Assert the diagnostic text in the throwing-source test case. Alternatively, set `source` in the catch fallback so the validator keeps the real error.
3. `we:scripts/operations/run.mjs:536` — Add an http-adapter test that runs the GET path for resource-pool against a temp coord root and asserts that no ledger file is created.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7385@72afa8b8db3a7aee505ef05927065abc28eb9580

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
