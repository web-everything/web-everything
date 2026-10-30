---
bornAs: xxuzqtp
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/conveyor/health-investigate-dispatch.mjs", "we:scripts/lib/__tests__/routing-overrides.test.mjs", "we:scripts/lib/dispatch-routing-policy-io.mjs", "we:scripts/lib/dispatch-routing-policy.json", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/lib/policy-cascade.mjs", "we:scripts/operations/__tests__/http-adapter.test.mjs", "we:scripts/operations/__tests__/review-red-team.test.mjs", "we:scripts/operations/__tests__/routing-override.test.mjs", "we:scripts/operations/__tests__/runner-freshness.test.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-seat-policy.mjs", "we:scripts/operations/routing-override-file.mjs", "we:scripts/operations/routing-override.mjs", "we:scripts/operations/run.mjs"]
scopeRationale: "Existing review-dispatch, review-extra-seats and run tests are exercised unchanged; new coverage lives in the routing-override suites listed in A1."
dateOpened: "2026-10-30"
tags: []
---

# Operator routing overrides without a code deploy (review-seat first)

Operator-owned platform-preferences routingOverrides layer over the routing policy for review-seat entries, live reload, validated with last-good retention, logged as routing-override-applied, set by the routing-override operation. Delivered by this PR; resolve on merge.

## Acceptance

- [A1] **Executable** — the following command, run from the WE checkout, exercises live reads, writes, seat routing, and failure retention. These suites require the routing-override implementation and regress the guarantees below.

```bash
node scripts/readiness/remote-exec.mjs -- npm run test:unit -- scripts/lib/__tests__/routing-overrides.test.mjs scripts/operations/__tests__/routing-override.test.mjs scripts/operations/__tests__/review-red-team.test.mjs
```

- [A2] **Must refuse invalid edits** — unknown operations/providers/models, contradictory controls, torn or unreadable preferences retain the last validated policy; invalid CLI writes preserve the original bytes.
- [A3] **Must scope authority and enables** — only operator preferences supply overrides. Repo preferences are ignored with a warning; enables apply to the selected seat, with explicit env caps, quota checks, and reservations still binding. JSON config/data receives the same validation as CLI input; source code and documentation cannot grant operator authority.
- [A4] **Must reload and report** — validated changes and clears take effect on the next read, emitting one platform-provenance event per changed operation. Event-sink failure cannot block application. Clearing restores repo defaults.

This is a local CLI/file operation, with no HTTP receive endpoint: HTTP body-size limits, rate limits, and CSRF/origin checks do not apply. Filesystem access is the authority boundary. Clear targets one validated operation key under the same lock and validation as writes; it cannot reset unrelated preferences.

## Non-goals

- [N1] No web API, authentication service, arbitrary model discovery, code deployment, or bypass of quota/cap/critical-work checks. The CLI exposes provider/model selection and clear; advanced validated controls remain file settings. This does not change mandatory review verdict authority or allow judged operations to reuse juror control names as inputs.

## Edge cases this change must handle

1. **Untrusted text** — treat configuration and CLI values as data; validate keys, provider/model catalog membership, and control combinations before use or write. No shell execution is involved in applying an override.
2. **Truncated reads** — incomplete JSON fails parsing; reads retain last good, and writes refuse to overwrite the damaged file. No partial-read result becomes an applied policy.
3. **Shared state files** — hold the shared file lock over read-modify-validate-write, then atomically rename the replacement; preserve unrelated preferences and concurrent updates. Lock failure writes nothing.
4. **Fail closed** — reject invalid operation/provider/model/control combinations and unreadable preferences; retain last good and log the failure. Operators can repair the file or clear the offending key; validation still applies.
5. **Identity scoping** — only the operator-owned preferences path (or explicit replacement) grants routing authority; committed current/legacy platform files cannot. Provider enables are per seat; provider ledgers remain shared and bounded.
6. **State over time** — every read validates the current repo-plus-operator snapshot; invalid edits keep last good, valid repairs recover, and clear restores repo defaults. Event deduplication is per applied operation change, not per poll.
7. **Who wrote it** — filesystem permissions establish operator authority; repo changes cannot masquerade as live operator overrides. Events record `source: platform` and operation/task/provider/model, not authenticated human identity; no stronger authorship is claimed.

## Risks

- An invalid or torn edit deliberately keeps an older policy active. The operator must heed the logged error and repair or clear it; retention and recovery are covered by `retains last good on unreadable or torn operator preferences, then recovers`.
- An enable must not spread to other seats or bypass an explicit zero cap. The inherited/fallback isolation cases and the env-cap/reservation cases in the test plan cover these boundaries.
- Events are best effort: a sink failure can leave an audit gap while valid routing applies. Both failure modes have named tests below; errors are logged.
- Catalog aliases can drift from the agy model form. The effort-suffixed alias test validates against the policy catalog and pins historical compatibility; it does not claim a live provider availability probe.

## Test plan

All names below are executable cases. Run through the A1 remote command (whose local fallback uses host heavy admission); also run the affected `we:scripts/lib/__tests__/policy-cascade.test.mjs`, `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs`, `we:scripts/operations/__tests__/review-extra-seats.test.mjs`, and `we:scripts/operations/__tests__/review-dispatch.test.mjs` suites and `npm run check:standards` through heavy admission.

| Guarantee | Test file and named case |
| --- | --- |
| Validated merge, fallback replacement, disable filtering, immutable repo snapshot | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `merges effort leaves, replaces fallback order, and gives platform selection precedence over repo policy`; `applies operation provider disables after resolving an inherited task-type route`; `filters disabled inherited fallbacks while retaining task-type provider disables` |
| Invalid configuration retains last good and logs once; torn/unreadable input recovers | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `retains last good on invalid override and logs once: %j`; `retains last good on unreadable or torn operator preferences, then recovers` |
| Operator-only authority, repo warning, replacement path | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `ignores and warns about repo routingOverrides in %s without preventing operator overrides`; `loads the existing operator file after repo platform defaults and supports an explicit replacement path` |
| Seat-local enables on inherited and fallback routes | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `keeps a Gemini enable local to its seat when another seat uses an %s route` |
| Finite default enable, unchanged positive defaults, explicit env bounds and reservation exhaustion | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `enables an unset default-zero provider with a finite cap and honours explicit disables`; `preserves explicit zero and positive env caps when an override enables %s via %s`; `runs an overridden Gemini advisory seat with env cap %s, preserving the reservation bound` |
| Red-team live routing retains quota/CLI checks and restores defaults after clear | `we:scripts/operations/__tests__/review-red-team.test.mjs`: `skips a provider under a quota hold and a missing CLI, and says why when none is left`; `reloads red-team routing each pass, enables unset Gemini, preserves explicit zero, and restores disable on clear` |
| Live reload, clear, event provenance and deduplication | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `reloads changes and clearing with one real JSONL event per operation change, never per pass` |
| Synchronous throw and rejected event emission cannot prevent apply/clear | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `applies a validated policy when event emission %s` |
| Current agy alias catalog membership and historical persisted IDs | `we:scripts/lib/__tests__/routing-overrides.test.mjs`: `uses effort-suffixed Sonnet aliases accepted by the agy catalog while accepting historical persisted ids` |
| Atomic scoped write/clear, unrelated preference preservation, missing operator file | `we:scripts/operations/__tests__/routing-override.test.mjs`: `declares and executes CLI write and clear, preserving unrelated preferences and entries atomically`; `uses the operator file replacement and creates a missing preferences file` |
| Concurrent write/clear, lock refusal, torn input, invalid CLI values preserve bytes | `we:scripts/operations/__tests__/routing-override.test.mjs`: `serializes an overlapping %s and write without losing either update`; `refuses to modify preferences when the shared lock cannot be acquired`; `refuses torn preferences without overwriting them`; `refuses invalid CLI requests without modifying preferences: %j`; `validates provider/model ids against the shared roster before writing` |
| Judged model/provider names stay reserved; absent controls remain closed | `we:scripts/operations/__tests__/routing-override.test.mjs`: `keeps %s reserved for juror controls on judged operations`; `derives provider/model as inputs only where declared, keeping absent juror flags closed` |
