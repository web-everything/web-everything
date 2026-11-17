---
kind: task
status: active
scaffoldedBy: "lpdw"
dateScaffolded: "2026-11-16"
dateOpened: "2026-11-16"
tags: []
---

# lane-pool acquire defaults --wait-ms to a short bounded wait (no lane within 0ms on transient pool-lock contention)

Auto-pick acquire waits up to 8000ms for transient contention when `--wait-ms` is omitted. `LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS` accepts nonnegative safe integers, clamps to 60000ms, and falls back to 8000ms with a warning on invalid input. The default polling budget starts after setup and reaping. Every acquire may attempt its first scan, including a zero default. Later scans cannot start after the default deadline; expiry preserves the last scan's evidence for bounded growth and recovery. Explicit waits retain their existing policy.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- lane-pool-acquire-default-wait` (we:scripts/__tests__/lane-pool-acquire-default-wait.test.mjs): omitted flag polls for 8000ms; valid overrides apply; zero scans once without polling; explicit zero wins over the environment; unsafe, negative and malformed values warn and fall back; oversized safe integers clamp to 60000ms. Valid and unset values emit no fallback warning on the omitted-flag path.
- [A2] **Executable** — The same suite's slow-reaper integration and CLI cases prove setup cannot consume the default polling budget or suppress the first scan. The scan-start policy cases refuse expired rescans and retain the full timeout for scans already started.
- [A3] **Executable** — `npm run test:unit -- lane-pool-acquire-growth lane-pool-recover-race` (we:scripts/__tests__/lane-pool-acquire-growth.test.mjs, we:scripts/__tests__/lane-pool-recover-race.test.mjs): completed empty scans still permit bounded growth and recovery with cache TTL zero, TTL shorter than the wait, or `--no-cache`. Retry candidates undergo fresh eligibility and atomic claim checks, including under `--force`.
- [A4] **Must refuse** — Scan timeout, unanswered shared-scan lock, partial lock handoff and provisioning failure remain insufficient evidence for growth or recovery. The default-wait suite's `never grows or recovers after %s` cases and existing growth/refusal suites defend these paths.
- [A5] **Must preserve** — A new deadline changes no work-preservation rule: source, documentation, configuration and data in dirty/unpushed lanes remain guarded by the same eligibility, claim and pre-reset checks.

This is a local CLI change; no receive endpoint, CSRF surface or request-body limit is introduced.

## Non-goals

- [N1] Do not bound the duration of an already-running scan, reaper, clone or recovery by the polling wait. This is not an 8s whole-command timeout.
- [N2] Do not change explicit lane selection, explicit wait timing, lease ownership, pool hard caps, recovery eligibility or reset protections.

## Edge cases this change must handle

1. **Untrusted text** — Parse the environment as a nonnegative safe integer; quote invalid input in the warning. No shell interpolation is added.
2. **Truncated reads** — Partial shared-scan evidence may identify candidates but cannot justify growing or recovering capacity.
3. **Shared state files** — Keep the shared scan lock and atomic lease claim. A stale candidate still must pass current eligibility and preservation checks.
4. **Fail closed** — Keep timeout, lock-contention, remote-probe and provisioning refusals. Refusing to start a rescan is not itself new evidence about capacity.
5. **Identity scoping** — Keep pool-scoped self-lane exclusion and existing holder checks; no lease identity format changes.
6. **State over time** — Reaping precedes the default wait clock. First scans always get a chance; expired rescans preserve the most recent result, including its uncertainty.
7. **Who wrote it** — No new authorship or authority source; the setting only selects wait duration.

## Risks

- R1: Slow setup consumes the wait or zero prevents a free lane from being discovered (A1/A2).
- R2: Cache expiry erases a completed scan and suppresses growth/recovery (A3).
- R3: Reusing evidence accidentally treats a timeout or partial lock answer as known capacity, or a retry overwrites concurrent work (A4/A5).
- R4: A warning test bypasses the emitting branch, leaving valid/unset settings noisy (A1).

## Test plan

- R1 → `we:scripts/__tests__/lane-pool-acquire-default-wait.test.mjs`: `a slow reaper does not consume the polling budget or prevent the first scan`, `a slow reaper IO read still allows the first CLI scan to acquire a free lane`, `env=0 acquires a free lane on the first uncached scan`, and `a zero environment default scans a held pool once and reports known capacity without polling`.
- R2 → the same suite's `an expired uncached rescan preserves completed evidence for recovery=%s`; `we:scripts/__tests__/lane-pool-acquire-growth.test.mjs`: `default expiry with %s still grows from a completed empty scan`; `we:scripts/__tests__/lane-pool-recover-race.test.mjs`: `acquires a recovered lane after default expiry with %s`.
- R3 → default-wait `never grows or recovers after %s`; growth `skips a newly grown lane that becomes %s before the retry, even with --force`; existing remote-failure and recovery-race tests. Scan-start policy tests also pin deadline refusal under the lock and the unchanged 120s scan budget.
- R4 → default-wait `omitted --wait-ms with environment %s prints no fallback warning`, with distinct unset and valid values and no explicit flag.
- Soak: `we:scripts/conveyor/soak/breaks/lane-acquire-default-wait.soak.test.mjs` includes slow setup, zero default, and uncached growth/recovery via the production loop and shared-scan implementation with injected private IO, alongside the real held-pool CLI replay.

## Prevention follow-up

The review's slow-reaper, zero-default and warning-path prevention requests are implemented by A1/A2 and their named tests. For future negative warning assertions, review that the test actually enters the branch that could emit the warning.

The requested card-lint prevention is already tracked by [#5605](5605-prevention-add-a-check-standards-rule-that-errors-on-an-open.md) and [#4706](4706-prevention-add-a-check-standards-rule-that-rejects-any-backl.md). PR #6963 adds the active/done case: reject unfinished Acceptance or Edge cases in either status. That repository-wide checker remains follow-up work; this repair fills the card itself.

The two later-round card suggestions duplicate mandatory findings in this review: the unset-warning test is covered by A1 and uncached growth/recovery by A3. This card records both rather than creating duplicate implementation work.

## Duplicate admission

existing wait-ms cards (4087,4173,7612,7695) fix overshoot/deadline of an explicit --wait-ms; this changes the omitted-flag default from instant-fail to a short bounded wait
