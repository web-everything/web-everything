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

- [A1] **Executable** — `npm run test:unit -- scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` includes these named regressions:
  - `boot rollback preserves expired reader leases of unknown liveness` asserts the expired reader entry is unchanged, recovery times out, and the rollback marker remains.
  - `unreadable rebuild state refuses promotion and rollback: %s` covers corrupt JSON, a directory, a missing file, an array and null; neither a rollback request nor boot application succeeds, and healthy tick evidence cannot promote provenGood.

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
