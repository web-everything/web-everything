---
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["blue-green-adopt"]
---

# Probation rollback: no-reclaim lock policy and fail-closed unreadable state

Two residuals ruled under R825 from the final S2 probation audit. Boot rollback must preserve expired reader leases of unknown liveness, and probation must refuse promotion and rollback when rebuild state cannot be read. The S2 repair disables lease/PID reclamation for boot rollback and uses a strict rebuild-state read for probation evidence.

## Acceptance

- [A1] **Executable** — `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` (run from WE with `npm run test:unit -- <test-file>`, using the path after `we:`) includes these named regressions:
  - `boot rollback preserves expired reader leases of unknown liveness` asserts the expired reader entry is unchanged, recovery times out, and the rollback marker remains.
  - `unreadable rebuild state refuses promotion and rollback: %s` covers corrupt JSON, a directory, a missing file, an array and null; neither a rollback request nor boot application succeeds, and healthy tick evidence cannot promote provenGood.
- [A2] **Executable prevention for PR #6882 advisory** — required unit regressions:
  - `requestRollback refuses incomplete adopted inputs without writing a marker: %j` and `requestRollback validates caller fields before replacing existing recovery evidence` require writer-side refusal and preservation; the shared `markerOK` validator also guards boot consumption.
  - `every required boot marker field survives the writer and is accepted by the reader` pins the persisted writer/reader contract.
  - `an unreadable probation file is kept and alerted once, never treated as none` polls four times and requires exactly one matching alert.
  - `probation watch does not overlap pending interval probes: %s` holds both outcome checks and rollback requests across multiple intervals, then verifies monitoring resumes.
  - `failed probation persistence alerts without changing the adoption result` in `we:scripts/lib/__tests__/daemon-rebuild-events.test.mjs` forces a failed probation rename and requires the persisted `probation-open-failed` alert.
  - `superseded boot rollback restarts stale code before any tick` in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` requires immediate restart before rebuild, lease or tick despite restart spacing.
  - `we:scripts/conveyor/soak/breaks/probation-rollback-marker-validation.mjs` exercises missing adopted input evidence, refusal alerts, evidence preservation and successful boot consumption after operator repair. `we:scripts/conveyor/soak/breaks/probation-rollback-marker-validation.soak.test.mjs` registers the regression in the soak gate.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

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
