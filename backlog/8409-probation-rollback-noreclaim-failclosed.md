---
bornAs: xp2v9dc
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["blue-green-adopt"]
---

# Probation rollback: no-reclaim lock policy and fail-closed unreadable state

Two residuals ruled under R825 from the final S2 probation audit. Boot rollback must preserve expired reader leases of unknown liveness, and probation must refuse promotion and rollback when rebuild state cannot be read. The S2 repair disables lease-expiry reclamation for boot rollback, permits reclamation only for verifiably dead same-host PIDs, and uses a strict rebuild-state read for probation evidence.

## Acceptance

- [A1] **Executable** — `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` (run from WE with `npm run test:unit -- <test-file>`, using the path after `we:`) includes these named regressions:
  - `boot rollback preserves expired reader leases of unknown liveness` asserts the expired reader entry is unchanged, recovery times out, and the rollback marker remains.
  - `unreadable rebuild state refuses promotion and rollback: %s` covers corrupt JSON, a directory, a missing file, an array and null; neither a rollback request nor boot application succeeds, and healthy tick evidence cannot promote provenGood.
- [A2] **Executable prevention for PR #6882 advisory** — required unit regressions:
  - `invalid %s adoption identity is unreadable` and `probation mutation with a mismatched adoptionId changes no file: %s` require writer-side refusal and preservation; the shared `markerOK` validator also guards boot consumption.
  - `open stamps a fresh UUID; boot and marker preserve that adoption id` pins the persisted writer/reader contract.
  - `persistent %s refusal alerts exactly once and preserves evidence` polls four times and requires exactly one matching alert.
  - `all writers stay out while asynchronous boot recovery holds the shared mutex` holds finalization while every other mutator attempts entry. S2a removes timers and asynchronous outcome checks; S2b owns outcome checks.
  - `failed probation persistence alerts without changing the adoption result` in `we:scripts/lib/__tests__/daemon-rebuild-events.test.mjs` forces a failed probation rename and requires the persisted `probation-open-failed` alert.
  - `superseded boot rollback restarts stale code before any tick` in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` requires immediate restart before rebuild, lease or tick despite restart spacing.
  - `we:scripts/conveyor/soak/breaks/probation-rollback-marker-validation.mjs` exercises missing or malformed adoption identity, refusal alerts, evidence preservation and successful boot consumption after operator repair. `we:scripts/conveyor/soak/breaks/probation-rollback-marker-validation.soak.test.mjs` registers the regression in the soak gate.
- [A3] **Executable prevention for persistent recovery failures (PR #6882 advisory, 2026-11-16)**:
  - `two boots stop restarting after persistent rollback failure: %s` in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` compares stale and fresh boot snapshots for target refusal, unreadable completion state, write/unlink errors, lock refusal/errors, marker replacement/consumption and unresolved/throwing HEAD reads. Persistent failures keep recovery evidence; matching known heads do not request another restart. Unknown HEAD before a reset defers recovery without treating missing evidence as proof of a changed checkout.
  - `recovery cleanup failure after reset still retires loaded failed code` also boots a second self-sync wrapper, requiring the fresh process to tick without restarting while the unreadable state and marker persist.
  - `post-reset HEAD read failure retires failed code only once` requires retirement after a reset-capable finalization loses HEAD access, followed by no repeated restart on the next boot loaded from the restored head.
  - `persistent %s refusal alerts exactly once and preserves evidence` polls each request refusal and unreadable promotion state four times, requiring one alert per root and reason.
  - `boot rollback reclaims a verifiably dead same-host reader without expiring live readers` requires recovery past a dead local PID while retaining an expired live local reader. The A1 unknown-liveness preservation test remains required.
  - `we:scripts/conveyor/soak/breaks/probation-persistent-recovery.mjs` wires the real boot hook through two self-sync wrappers with a persistent refusal, polls the real probation path, and recovers a dead local reader. `we:scripts/conveyor/soak/breaks/probation-persistent-recovery.soak.test.mjs` joins the unit gate through directory discovery.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## S2a scope and follow-ups

S2a uses adoption UUIDs, one shared probation mutex, boot deadline enforcement,
synchronous previous-tick liveness checks, and caller-owned restart. All mutation
checks run after acquiring the mutex; HEAD changes retain the clone write lock.
The continuation side-file and timer watcher are removed.

- [S2b outcome checks](8558-probation-outcome-checks.md) requires adoption checks after asynchronous work.
- [S2c external watcher](8559-probation-external-watcher.md) owns r1 (crash before the boot hook) and r2 (a tick that never returns). The next boot still enforces S2a's deadline.

## Non-goals

- [N1] n/a: nothing is excluded beyond the two residuals above.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: covered by the two residuals above; no new surface.
2. **Truncated reads** — n/a: covered by the two residuals above; no new surface.
3. **Shared state files** — n/a: covered by the two residuals above; no new surface.
4. **Fail closed** — n/a: covered by the two residuals above; no new surface.
5. **Identity scoping** — n/a: covered by the two residuals above; no new surface.
6. **State over time** — n/a: covered by the two residuals above; no new surface.
7. **Who wrote it** — n/a: covered by the two residuals above; no new surface.

## Duplicate admission

R825 residuals from the S2 probation audit

new residuals found by the final S2 audit
