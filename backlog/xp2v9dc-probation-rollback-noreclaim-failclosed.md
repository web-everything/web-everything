---
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["blue-green-adopt"]
---

# Probation rollback: no-reclaim lock policy and fail-closed unreadable state

Two residuals ruled under R825 from the final S2 probation audit. (1) The boot rollback takes the normal clone write lock, which still reclaims expired reader leases of unknown liveness; add a no-reclaim policy for this caller. (2) Unreadable rebuild state reads as empty, so the forceUnverifiedTrees guard sees nothing flagged; probation must fail closed when state cannot be read.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` includes a test where an expired reader lease is not reclaimed by boot rollback and a test where unreadable state refuses provenGood/rollback.

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
