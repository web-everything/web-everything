---
bornAs: xp2v9dc
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["blue-green-adopt"]
---

# Probation rollback: no-reclaim lock policy and fail-closed unreadable state

R825 follow-up retained for PR #6882. R952/R955 scopes S2a to adoption identity, serialized mutations, boot/tick boundary checks, and caller-owned restart. Outcome checks are tracked in [S2b](xs2bout-probation-outcome-checks.md). Module-load crashes (r1) and forever-hung ticks (r2) are tracked in [S2c](xs2cwat-probation-external-watcher.md); the next successful boot enforces the deadline, and tickStarvedSmell remains the existing r2 alert.

## Acceptance

- [A1] Boot rollback preserves expired reader leases of unknown liveness; only a verifiably dead same-host PID permits reclamation. The named tests in `scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` and `probation-recovery.test.mjs` assert refusal, unchanged reader evidence, and retention of the rollback marker.
- [A2] An unreadable rebuild state refuses promotion and rollback; malformed probation or markers stay for operator recovery and produce a bounded alert. `probation.test.mjs` covers these closed paths.
- [A3] Recovery failures after a reset retire stale loaded code, while a fresh process matching restored HEAD can proceed without a restart loop. Earlier recovery, replaced-marker, reader-lease, and state-preservation regressions are retained in `probation-recovery.test.mjs`.
- [A4] S2a's mutator table in `probation.test.mjs` requires every mismatched adoptionId to preserve probation, marker, provenGood and rebuild-state bytes. The late-open and stale-request cases cover B/C replacement.
- [A5] `daemon-self-sync.test.mjs` proves startup failure is recovered at a later boot and a fail verdict invokes onRestart exactly once without probation calling process.exit. `skills-src/conveyor/__tests__/runner-shutdown.test.mjs` exercises the production runner shutdown factory, drain and lease release.
- [A6] The soak scenarios `probation-startup-failure`, `probation-no-restart-adoption`, `probation-sibling-startups`, `probation-caller-ownership`, `probation-persistent-recovery`, `probation-rollback-marker-validation`, and `probation-boot-rollback-restart` cover the corresponding call paths.

## S2a test migration

Timer overlap, observeOnly, continuation side-file and unused outcome-check tests are superseded by synchronous boundary and adoption-identity tests. Rollback requests use the locked probation's inputsKey, so incomplete unrelated adopted-state metadata cannot corrupt marker construction. Invalid caller reasons still refuse with an operator alert. A one-shot rebuild never creates probation or registers a boot; daemon rebuild only opens probation and self-sync registers the boot.

## Non-goals

Semantic outcome checks, external module-load supervision, and preemption of a permanently hung tick are follow-ups S2b/S2c. S2a does not claim to recover r1 before another successful boot.

## Edge cases

- Shared state: one clone-scoped mutex; atomic JSON rename; re-read identity under lock; no expiry-only reclamation.
- Recovery: clone write lock before probation lock, revalidate target, persist rejected inputs before reset, preserve evidence on failure.
- Identity: UUID carried by probation, boot registration and rollback marker; stale callbacks cannot mutate a newer adoption.
- Unreadable evidence: fail closed and alert; never manufacture a proven-good target from adoption alone.
- External input: no new network endpoint or remote text execution surface.

## Duplicate admission

R825 residuals from the S2 probation audit, retained after the S2a re-scope.
