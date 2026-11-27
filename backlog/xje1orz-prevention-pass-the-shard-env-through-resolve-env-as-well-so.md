---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/verify-since-last-green.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Pass the shard env through resolve(env) as well, so it reaches the gate, or assert on the env the… (from web-everything/web-everything#7565 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/verify-since-last-green.test.mjs:170` — Pass the shard env through resolve(env) as well, so it reaches the gate, or assert on the env the gate actually received. Alternatively add a small test-helper lint that flags vi.stubEnv in suites whose subject takes an injected env.
2. `we:scripts/lib/__tests__/verify-since-last-green.test.mjs:26` — Add a deterministic test that instruments settings-file reads during a fresh gate import and asserts zero reads with checkout and platform preferences present.
3. `we:scripts/lib/__tests__/verify-since-last-green.test.mjs:29` — Add a deterministic import-isolation test that detects reads of checkout and platform settings, and confirm that removing the loader mock makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7565@92a7e416fc418fe6a572a3ddb8ea3081aa4c8684

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
