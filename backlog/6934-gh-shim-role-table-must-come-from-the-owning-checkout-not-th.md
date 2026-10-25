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
- [A2] **Executable** — In the same suite, add the parameterized test `owner configuration failures preserve daemon refusal without writer substitution`, one case each for: absent owner roles, partial owner roles (worker only), an unavailable owner checkout (missing settings dir), and owner configuration changed between two writes. Each case renders and executes the shim and asserts (a) the baked role table equals the owner's (or is empty), never the writer's, and (b) a daemon `gh auth token` with no fresh App token exits 1 with the refusal, with no real-gh call.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Changing the personal-auth refusal itself, the fallback policy source (already owner-derived via `shimFallbackPolicy`), or how a role App token is minted.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the role table is read from the owner checkout's settings files, never from argv or remote text.
2. **Truncated reads** — An unreadable or partial owner settings file bakes an empty role table (legacy App), never the writer's table.
3. **Shared state files** — Two writers of the same per-checkout shim must bake the same table; the last write wins with identical content.
4. **Fail closed** — Any owner-config read error keeps the daemon refusal for personal auth; it never widens access.
5. **Identity scoping** — Only the owning checkout's delivery.identity decides roles; a writer's WE_DELIVERY_IDENTITY / WE_PLATFORM_PREFERENCES_FILE is ignored.
6. **State over time** — A changed owner config takes effect on the next write; the test covers a change between two writes.
7. **Who wrote it** — The table is derived from the shim's owner (`ghThrottleCliPath`), not from whichever process wrote the shim.
