---
bornAs: xng8z32
kind: story
size: 5
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle*.test.mjs", "we:scripts/lib/gh-app-shim.mjs", "we:scripts/lib/__tests__/gh-app-shim.test.mjs", "we:scripts/conveyor/health-smells/gh-caller-attribution.mjs", "we:scripts/conveyor/health-smells/__tests__/gh-caller-attribution.test.mjs", "we:skills-src/conveyor/launchd/*.plist.example", "we:skills-src/conveyor/*.plist.example", "we:skills-src/conveyor/__tests__/launchd-caller-label.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "aee6a7c1da2d844c2b95c00c86f72a4f8eae2f3f"
tags: []
---

# Every GitHub call carries a caller name (historical finding: 40% unattributed)

Held finding 225 (coroner-5) reported 13.2k calls/h after the 18:30 ET shim fix, including 3.2k unknown and 2.0k node calls/h. Its separate 12-hour sample reported 18.9k unknown + 4.5k node out of 114.5k deduped calls. These are historical observations, not a reproduced current rate or a single consistent 40% denominator. Preserve the goal: attributable GitHub invocations and a configurable health alert when caller attribution is missing.

## Progress

- Original premise/scope: attribution needed implementing in the shim and `runGhSync`, with launcher templates mentioned only in prose; scope listed only `we:scripts/lib/gh-throttle.mjs`. Historical evidence was the host-local call log at `we:.lanes/.admission/gh/calls.jsonl` for the reported 2026-10-10 12:14Z–00:24Z interval (end date unspecified). This preparation did not reproduce that interval.
- Corrected premise: attribution already exists. `we:scripts/lib/gh-throttle.mjs:504` resolves explicit caller, `GH_CALLER`, script basename, then unknown; `we:scripts/lib/gh-throttle.mjs:1654` uses it. `we:scripts/lib/gh-app-shim.mjs:428` resolves `GH_CALLER`, parent script, session identifier, then parent executable; `we:scripts/lib/gh-app-shim.mjs:451` forwards the result through `WE_GH_THROTTLE_CALLER`, consumed at `we:scripts/lib/gh-throttle.mjs:2063`. Neither resolver recognizes `WE_GH_CALLER` or a dedicated launcher-label fallback.
- Existing coverage is `we:scripts/lib/__tests__/gh-throttle.test.mjs:630` and `we:scripts/lib/__tests__/gh-app-shim.test.mjs:550`. `we:skills-src/conveyor/pass-daemon.mjs:238` already supplies precise per-pass `GH_CALLER`; preserve it. Launcher labels are available in templates, for example `we:skills-src/conveyor/launchd/com.we.health-watch.plist.example:52`, but are not explicitly exported as fallback metadata.
- Caller identity and spend attribution are different measurements. `we:scripts/lib/gh-spend.mjs:174` attributes measured cost and `we:scripts/lib/gh-spend.mjs:273` aggregates by caller. Its unattributed bucket delta does not mean unnamed callers. No spend-accounting rewrite is needed. `we:scripts/conveyor/health-smells/gh-call-failures.mjs:24` currently measures failures/writes, not caller coverage. `we:scripts/conveyor/health-watch.mjs:676` already supplies a bounded call-log probe, and `we:scripts/conveyor/health-smells/index.mjs:31` discovers new smells automatically.
- Corrected scope includes both attribution writers, their existing tests, a new smell with its matching test, and launcher templates with a planned template-contract test. Size changes **2 → 5**: approximately 45 changed lines in the throttle, 50 in the shim, 90 in the new smell, 70 across 14 launcher templates, and 200 across three test areas (roughly 455 lines). The estimate reflects existing precedence/relay seams cited above plus template coverage, not a new GitHub transport. This remains a story; no `estimatedLoc` is added.

## Design

1. Keep explicit `throttle.caller` strongest. Preserve existing `GH_CALLER` precedence for compatibility and precise pass identity; accept `WE_GH_CALLER` next as the new explicit environment alias. Ignore blank/whitespace-only candidates. Direct calls then use the entry script basename, excluding the throttle CLI itself; shim calls use the actual parent script inferred by the existing bounded absolute-path process probe. The shim's own entry filename must never become a caller.
2. Add `WE_GH_LAUNCHER_LABEL` as fallback metadata, populated with each template's existing Label value. Use it after script inference and before the shim's existing session/executable fallback. Keep session attribution and the final executable/unknown fallback for interactive callers. This is metadata, not an authenticated identity. Preserve the shim relay override and fallback-metering path; do not alter credential selection, budgets, retries or exit status. Check existing role-map tests because the shim also uses caller names for role lookup.
3. Add the automatically discovered `gh-caller-attribution` smell using the existing `ghCalls` probe. Alert on a caller-missing ratio strictly greater than the setting `WE_GH_CALLER_MAX_UNATTRIBUTED_RATIO` (default 0.10; finite values from 0 through 1, invalid values use the default). Use a 15-minute sampled window, at least 20 logical invocations, host scope, alert action, one opening tick and two closing ticks, following the existing failure smell's cadence and hysteresis.
4. Count only valid, in-window `outcome: call` records. Group retries by invocation ID and inner records by their outer ID; prefer the outer caller, following `we:scripts/lib/gh-spend.mjs:72`. Historical records without IDs count individually. Missing, blank, unknown and generic interpreter/shell names (node, nodejs, bun, deno, sh, bash, zsh, including absolute executable paths) are unattributed. A script, pass, launcher label or existing session identifier is attributable. Publish numerator, denominator, ratio, threshold and top generic callers; label this a bounded-log sample, not complete host spend.

## MVP

- Extend the two existing resolvers and preserve their transport contracts.
- Export fallback label metadata in the tracked conveyor launcher templates in scope; do not install or reload any daemon.
- Add the smell and regression coverage. Reuse existing probes and registry discovery; do not modify the spend ledger or add per-call GitHub requests.

## Acceptance

- [A1] The focused queued suites in the Test plan fail for the missing alias, launcher fallback and absent smell before implementation and pass after implementation.
- [A2] Generated shim and direct-wrapper probes produce the expected caller for explicit environment, script and launcher cases, including fallback metering; anonymous cases remain honestly marked and counted.
- [A3] A 20-invocation sample with three unattributed calls alerts at the default threshold; two does not. Raising the setting above the measured ratio suppresses the breach.
- [A4] Every scoped launcher template exports its own existing label, and existing per-pass `GH_CALLER` still wins.

## Non-goals

- No historical log rewriting, claim that all host GitHub traffic is instrumented, spend-cost reclassification, credential-policy change, or automatic daemon deployment. No new network endpoint: body caps, CSRF/origin checks and reset-abuse controls do not apply.

## Edge cases this change must handle

1. **Untrusted text** — caller labels and process output are data, never shell commands. Retain bounded process inspection and JSON serialization; avoid logging full command lines or credentials.
2. **Truncated reads** — retain the probe's torn-line skipping; a bounded tail may lose an outer record, so count the surviving inner record once and disclose sampled coverage.
3. **Shared state files** — use existing append logging and read-only probing; no new shared ledger or rewrite.
4. **Fail closed** — attribution failures do not block GitHub calls or fabricate identities; fall back honestly. Existing auth/admission behavior remains unchanged.
5. **Identity scoping** — caller identifies a producer, not credential ownership. Keep auth identity separate and test role selection for existing named callers.
6. **State over time** — ignore stale/invalid timestamps and future entries beyond the existing one-minute tolerance; no calls means no breach, not a claimed measured zero-percent host rate.
7. **Who wrote it** — retain explicit caller precedence, per-pass labels, invocation IDs and nested-record linkage; never substitute a guessed script for shell eval text.

## Test plan

- Extend `we:scripts/lib/__tests__/gh-throttle.test.mjs` for explicit/legacy/new-env precedence, blanks, basename, excluded CLI entry, launcher fallback and unknown; exercise actual `runGhSync` log output using fake execution and isolated state. Run the existing shim-routed and fidelity suites under `we:scripts/lib/__tests__/gh-throttle*.test.mjs` for nested metering and transport regressions.
- Extend `we:scripts/lib/__tests__/gh-app-shim.test.mjs` using its generated-shim subprocess fixtures for the alias, parent script, launcher fallback, session fallback, failed process inspection, direct fallback metering and existing role behavior. Use fake GitHub binaries, no live API writes.
- Add `we:scripts/conveyor/health-smells/__tests__/gh-caller-attribution.test.mjs`: threshold boundaries and override validation, minimum sample, empty/stale/malformed inputs, generic names, outer/inner/retry deduplication, legacy no-ID rows and episode open/close behavior through the existing health core.
- Add `we:skills-src/conveyor/__tests__/launchd-caller-label.test.mjs` to inspect both scoped template directories and assert fallback metadata equals each template's Label, without altering installed jobs.
- Execute focused files only through the host queue: invoke `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` and the listed test paths (strip the documentation-only `we:` prefix when forming executable arguments). Run `npm run check:standards` through that same queue. Preparation itself changes only this card; implementation tests are future work, not claimed passing here.

## Proof plan

1. Capture a red/green run of the new cases with the host queue. Preserve output showing the caller value from actual generated-shim and wrapper executions, using temporary logs and fake binaries.
2. Feed those emitted records plus a controlled anonymous sample into the registered smell and health core; demonstrate counts, configured threshold, episode opening and recovery. Inspect resulting records to prove nesting does not double-count and call results are unchanged.
3. After a separately authorized rollout, sample the real call log over an explicit before/after interval and report counts and generic-name share using the same grouping rules. Record whether the bounded tail covers that interval. Do not promise the historical 40% reduction or infer runtime deployment from green template tests.

## Follow-ups

- Operator rollout/regeneration of installed shims and launcher configuration is separate from this code change; verify the emitted environment before claiming live coverage.
- Use the resulting alert's generic-caller samples to locate remaining uninstrumented launchers. Expand instrumentation only from observed gaps; keep unnamed-caller ratios separate from unassigned rate-limit cost.
