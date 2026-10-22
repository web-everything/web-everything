---
bornAs: xxzvw29
kind: story
size: 3
status: open
scope: ["we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/github-app-identity.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# gh shim role table must come from the owning checkout, not the writer's identity env

we:scripts/lib/gh-app-shim.mjs#buildGhShimSettingsEnv bakes roleTable/callerRoles from we:scripts/lib/github-app-identity.mjs#readDeliveryIdentity({ env }) of whichever process writes the shared per-checkout shim, honouring that writer's WE_PLATFORM_PREFERENCES_FILE and WE_DELIVERY_IDENTITY. One writer pinning identity none bakes an empty table, so every daemon sharing the shim silently signs with the legacy App instead of its role App (role separation collapses; personal-auth refusal is unaffected). Same shape PR #5729 fixed for the fallback policy via shimFallbackPolicy. Fix: resolve the identity from the checkout that owns ghThrottleCliPath with env {}. Edge cases: no role configured; partial roles; the owner checkout mid-reset; roles changing between two writers. Needs a two-writer test like the PR #5729 shared-shim fallback suite.

## Acceptance

- [A1] **Executable** — Add `shared shim role table follows the owning checkout across conflicting writers`, with two writers supplying conflicting WE_PLATFORM_PREFERENCES_FILE and WE_DELIVERY_IDENTITY values (including none). Render and execute each shim, asserting the owning checkout's worker App token and caller-role mapping win both times. The test must fail with the current writer-derived role table. Run `npm run test:unit -- <suite>` from the WE checkout, using the repository-relative path for suite `we:scripts/lib/__tests__/gh-app-shim.test.mjs`.
- [A2] **Executable** — In the same suite, cover absent and partial owner roles, an unavailable owner checkout, and owner configuration changes between writes; preserve personal-auth refusal on every daemon error path and never substitute a writer's role configuration.

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
