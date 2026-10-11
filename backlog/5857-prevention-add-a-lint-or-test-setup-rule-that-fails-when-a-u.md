---
bornAs: x1py51j
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/github-app-auth-env.mjs", "we:scripts/conveyor/health-smells/github-app-token.mjs", "we:scripts/lib/__tests__/github-app-identity-gate.test.mjs", "we:scripts/lib/__tests__/github-app-auth-env.test.mjs", "we:scripts/conveyor/health-smells/__tests__/github-app-token.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a lint or test-setup rule that fails when a unit test reads real ~/.claude settings. For exam… (from web-everything/web-everything#4916 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/github-app-auth-env.mjs:299` — Add a lint or test-setup rule that fails when a unit test reads real ~/.claude settings. For example, stub readDeliveryIdentity globally in vitest setup, or set WE_DELIVERY_IDENTITY to an empty override in setup.
2. `we:scripts/conveyor/health-smells/github-app-token.mjs:43` — Add a smell test fixture where a role has a fresh cache history but is idle, and decide whether idle is a breach. If it isn't, gate role expiry breaches on recent role-caller activity.
3. `we:scripts/lib/github-app-auth-env.mjs:311` — Add a contract test for assessGithubAuthSection that feeds it the shape `{callers:[],roleCaches,legacyInUse}`. Alternatively, return null when there is no status, no callers and no role cache present.
4. `we:scripts/lib/__tests__/github-app-identity-gate.test.mjs:27` — Add a deterministic fallback-attribution test with different role and requestedRole values and assert each role's checkedAt and resulting breach; changing the selector to requestedRole must fail that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4916@a63a6a9e14cdaf0936803de16a147a052576a027

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
