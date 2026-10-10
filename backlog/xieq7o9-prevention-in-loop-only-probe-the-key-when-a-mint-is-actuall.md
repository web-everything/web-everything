---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/github-app-auth-env.mjs", "we:scripts/lib/__tests__/github-app-identity.test.mjs", "we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/__tests__/github-app-auth-env.test.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — In loop, only probe the key when a mint is actually needed, as the legacy path already does. Add… (from web-everything/web-everything#4834 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/github-app-auth-env.mjs:540` — In `loop`, only probe the key when a mint is actually needed, as the legacy path already does. Add a test that a fresh cache means zero `security` spawns.
2. `we:scripts/lib/__tests__/github-app-identity.test.mjs:205` — Add a unit test where mint returns `{ contents: 'read' }` for the merger role and assert `fallbackFrom[0].reason === 'insufficient-access'` with `missingPermissions` listed. Add a check:standards rule that a guarantee stated in a header or PR body names its test.
3. `we:scripts/lib/gh-app-shim.mjs:520` — Add a unit test asserting that a dispatched worker session never inherits a privileged role (merger or ledger). For real isolation, keep the merger and ledger caches out of the sessions' reach (separate OS user or cache dir), and treat the main ruleset as the actual boundary.
4. `we:scripts/lib/__tests__/github-app-identity.test.mjs:160` — Add a test with an under-permissioned mint for a role. A broader guard is a check that every guarantee stated in a card's edge-case list maps to a named test.
5. `we:scripts/lib/gh-app-shim.mjs:819` — Add a deterministic integration test in we:scripts/lib/__tests__/github-app-identity.test.mjs that constructs the shim through buildGhShimSettingsEnv with a custom caller mapping, omits WE_GITHUB_APP_ROLE, and asserts the selected App token.
6. `we:scripts/lib/github-app-auth-env.mjs:624` — Add a deterministic test in we:scripts/lib/__tests__/github-app-identity.test.mjs that returns insufficient permissions for a secondary installation and asserts that its token is rejected and routing reports the fallback.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4834@4749401beeefe91557dce9fb2b5f6a6ac0b80d24

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
