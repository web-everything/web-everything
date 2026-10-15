---
bornAs: x0wgz6d
kind: story
size: 1
status: active
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-15"
preparedDate: "2026-10-15"
preparedAgainstSha: "24d9ebca8ca0b935093575ddbcac52f217c0a6d2"
tags: []
---

# daemon-load-overlay waits for a running rebuild instead of giving up

Held finding 237 reported an immediate rebuild-in-progress result despite an explicit wait budget. Preserve that goal for an explicit overlay load: wait within the configured budget, retry through the existing rebuild machinery, and report adoption only after verifying the requested overlay is installed.

## Progress

- Validation complete: all 110 tests in `we:scripts/lib/__tests__/daemon-load-overlay.test.mjs` pass through heavy admission. Both new core regressions failed against the original loader before implementation. With the new loader, busy → busy → adopted makes three attempts with budgets 600/350/100ms, sleeps 250/250ms, and returns adopted true only with installed tip `tip` at head `fresh`. Perpetual busy makes three attempts with the same budgets, sleeps 250/250/100ms, and returns adopted false with `rebuild-in-progress` and 600ms elapsed. Coverage also includes shared-deadline stale follow-ups, exhaustion before follow-up, invalid budget fallback, other refusals/errors, failed-smoke removal/recovery after waiting, missing/advanced-tip evidence, dry-run/versioned isolation, and an admitted rebuild completing beyond the budget.
- Operational live-adoption proof was not performed; the tests use injected rebuilds and launch dependencies, with no live worker dispatch. Standards/gate execution and commit are left to the wrapper as directed by the delivery brief. No shared rebuild machinery or ordinary daemon-tick behavior changed.

- Implementation sanity read: the legacy loader still returns the first live-sibling refusal; the spec remains coherent. Edge cases named before implementation: repeated busy refusal, deadline reached during an admitted rebuild, stale adoption sharing the deadline, invalid/non-finite/non-positive budgets, other refusal/throw, missing installed evidence or advancing ref, and dry-run/versioned isolation. Implemented the legacy-only monotonic deadline loop with asynchronous sleeps capped at 250ms, remaining-budget lock options, first-wait/final-outcome logging, installed-tip verification and unchanged rollback recovery.

- Rechecked at 24d9ebca8: original premise was an explicit wait yielding immediately; corrected scope remains the legacy explicit loader plus its existing matching test, not ordinary daemon ticks or the versioned waiter. The initial call at `we:scripts/lib/daemon-load-overlay.mjs:642` still has no busy retry; the follow-up at `we:scripts/lib/daemon-load-overlay.mjs:662` requires an adopted result first. The live-lease refusal is at `we:scripts/lib/daemon-rebuild/prepare.mjs:484`, and the remaining-budget injection is supported by `we:scripts/lib/daemon-rebuild/rebuild.mjs:86`. Retain size 1 (approximately 70 source + 110 test lines). All five preparation sections below remain applicable; no implementation or live adoption was performed. Runner-owned stamps are unchanged.

- Current-checkout recheck at 6d77e9169: retain the corrected loader-plus-test scope and size 1. The explicit loader still makes a single initial rebuild call at `we:scripts/lib/daemon-load-overlay.mjs:642`; the live-lease refusal remains at `we:scripts/lib/daemon-rebuild/prepare.mjs:482`. The concrete existing budget override is `lockOpts.waitMs`, merged last at `we:scripts/lib/daemon-rebuild/rebuild.mjs:86`; use that seam rather than inventing a top-level wait option. Existing prepared dates and hashes are left unchanged for the runner.

- Checked at 17242a56d; not delivered. Original scope named only `we:scripts/lib/daemon-load-overlay.mjs`. The early refusal actually comes from the live sibling build lease in `we:scripts/lib/daemon-rebuild/prepare.mjs:482`. The existing wait budget in `we:scripts/lib/daemon-rebuild/rebuild.mjs:72` controls clone-lock acquisition, not that lease refusal. The immediate yield is intentional for ordinary daemon ticks, so the shared rebuild machinery need not change.
- Corrected scope: the explicit loader and its matching test, `we:scripts/lib/__tests__/daemon-load-overlay.test.mjs`. The loader makes one initial rebuild call at `we:scripts/lib/daemon-load-overlay.mjs:642`; its existing follow-up rebuild call at line 662 only runs after an adopted build lacks the overlay. Neither retries an initial live-lease refusal. The versioned request/wait path at line 595 is separate and stays intact.
- Retain size 1: approximately 70 changed loader lines for bounded retry/dependency seams and 110 test lines for timing, installed-tip verification and refusal cases. No production shared-lock or lease changes, no stamps and no dependency changes.

## Design

In `we:scripts/lib/daemon-load-overlay.mjs`, wrap the legacy explicit-load rebuild attempt in an asynchronous deadline loop. Resolve the positive finite `WE_DAEMON_REBUILD_LOCK_WAIT_MS` budget with the existing default exported by `we:scripts/lib/daemon-rebuild/lease.mjs` (60 seconds); reject non-finite values by falling back to that default. Inject a monotonic clock and asynchronous sleep for tests; do not reuse the existing `now` registration timestamp as a clock.

Start one deadline before the first attempt. Retry only `reason: rebuild-in-progress`, sleeping at most 250 ms or the remaining budget between attempts, without holding a clone lock or build lease while sleeping. Pass the remaining budget as `lockOpts: { waitMs: remainingMs }` to the rebuild; do not reset the deadline on another refusal or on the existing stale-adoption follow-up. At exhaustion return a non-adopted result retaining the rebuild-in-progress cause and elapsed wait. Log the first wait and final outcome, not every poll. The budget bounds waiting/retry admission; a rebuild already admitted still completes its smoke/finalization under the existing safety protocol and can exceed that wall-clock budget.

A sibling finishing does not itself prove this overlay was included. Retry through the existing rebuild API so current registrations are planned, keep `installedClosed` verification against the requested ref, and preserve dispatch smoke, failed-smoke removal and rollback behavior. If an adopted candidate predates registration, use the existing bounded follow-up rebuild, subject to the same remaining wait budget. Never return adopted merely because the sibling lease disappeared. Exceptions and other refusal reasons keep their existing behavior; do not turn permission, smoke or Git failures into retry loops. Dry-run and versioned request/result waiting remain separate.

## MVP

- Deadline-based retry for a legacy explicit overlay load receiving a live-sibling refusal.
- Installed-ref and smoke checks remain required; exhaustion reports that nothing was adopted.
- Injectable time/sleep and deterministic regression coverage, with no change to ordinary daemon tick behavior.

## Test plan

In `we:scripts/lib/__tests__/daemon-load-overlay.test.mjs`, cover busy → busy → adopted with the requested tip present, and assert sleeps plus decreasing lock-wait budgets. Cover perpetual busy with a fake clock: bounded attempts, no sleep beyond the deadline and adopted false. The first two cases must expose the current one-call behavior.

Also cover sibling adoption lacking the requested tip followed by a rebuild that includes it, exhaustion before that follow-up, invalid/infinite budget fallback, a non-busy refusal, a thrown rebuild error, failed smoke and overlay rollback. Preserve dry-run and versioned-mode tests; ensure no legacy retry is invoked in either. Assert no success when installed-ref probing fails or the ref advances beyond the adopted build. Use injected dependencies, isolated state and no live worker dispatch.

Run this test file through Node on `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` and its filesystem path; run the standards gate through the same queue. Repo prefixes here are documentation, not executable path components.

## Proof plan

Capture the busy-then-adopt and perpetual-busy regressions against the old and new loader. Record attempt count, elapsed fake time, remaining budgets, final installed tip and returned adoption state. For operational proof after implementation, use an authorized disposable clone with one genuine rebuild already smoking, then load an overlay and capture the wait/adoption transcript and installed tip. Also use a short budget to show a clean non-adopted timeout. A unit stub alone does not prove live adoption; do not load production daemons merely to prepare this card.

## Non-goals

No second concurrent candidate, lock stealing, lease-TTL change, daemon-tick blocking, versioned protocol change or bypass of smoke verification.

## Edge cases this change must handle

Untrusted ref text continues through the existing validation and Git argv paths. Missing or unreadable installed-tip evidence refuses adoption. Shared state remains owned by the existing rebuild/registration APIs; this loop creates no writer. Identity is the clone plus requested overlay tip, never another clone's completion. Restarts re-enter normal registration/rebuild verification without persisting a new wait counter. No network receive endpoint is introduced, so request-body, CSRF and rate-limit policy is not applicable.

## Follow-ups

Measure explicit-load wait durations before changing the default budget. Any future shared lease-completion notification or versioned wait unification is separate work; polling here must not change opportunistic daemon tick behavior.
