---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-smells/github-app-config.mjs", "we:scripts/lib/gh-app-shim.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4834 (head 4749401be)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4834 (reviewed head `4749401beeefe91557dce9fb2b5f6a6ac0b80d24`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-smells/github-app-config.mjs:36` — (failing-input, degraded) Role fallback alerts disappear when no legacy cache exists
   - Scenario: On a host configured exclusively with role Apps, let the reviewer mint fail while the worker mint succeeds. The real refresh function records requestedRole:'reviewer', role:'worker', fallback:true. However, probeAppToken checks only the legacy cache, which role refreshes never create, so appToken.present is false and this smell returns []. Reproduced with injected in-memory cache and status storage. The fallback should produce a breach from its caller status regardless of whether a legacy cache exists.
   - Claude's re-check: A role App writes only to roleCachePath ('.app-&lt;id&gt;.json'), never the legacy cache. The smell's header says it is evaluated only when 'appToken.present' (the token cache exists on the host). On a role-only host the fallback caller record (fallback:true, requestedRole) is therefore never examined and the smell returns [].
2. `we:scripts/lib/gh-app-shim.mjs:816` — (failing-input, degraded) The generated shim silently discards callerRoles overrides
   - Scenario: Configure worker and reviewer Apps plus delivery.identity.callerRoles={'we:custom-review.mjs':'reviewer'}. Generate the shim through buildGhShimSettingsEnv, then invoke it with GH_CALLER=we:custom-review.mjs, no WE_GITHUB_APP_ROLE, and fresh caches for both Apps. Executing the generated script in memory selected the worker token without any warning, although the identity resolver returned reviewer. Neither buildGhShimSettingsEnv nor ensureGhShim forwards the resolved callerRoles to renderGhShimScript, so it always embeds DEFAULT_CALLER_ROLES. The configured override should select the reviewer token.
   - Claude's re-check: 'buildGhShimSettingsEnv' calls 'ensureGhShim' with only 'roleTable', and 'ensureGhShim' calls 'renderGhShimScript' without 'callerRoles'. The script therefore always embeds 'DEFAULT_CALLER_ROLES', and 'identity.callerRoles' overrides are dropped. With no 'WE_GITHUB_APP_ROLE' set, the shim's 'requestedRole' falls through to the default map and then worker.

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
