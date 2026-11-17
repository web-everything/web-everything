---
bornAs: x2bs2ap
kind: task
status: open
dateOpened: "2026-11-16"
tags: [daemon, probation]
related: ["8409"]
---

# S2b: adoption-bound outcome checks

Follow-up to PR #6882's S2a ruling. S2a proves process liveness from the previous
tick only. Restore application outcome checks in a separate slice after defining
how asynchronous results remain bound to an adoption UUID.

## Acceptance

- A result for adoption B cannot promote, reject, delete or restart adoption C.
- Re-read the adoption ID under the shared probation mutex after each await.
- Bound outcome execution; a failed or hanging check cannot overlap the next tick
  or bypass the caller's drain and lease release.
- Keep S2a boot deadline enforcement and the existing no-reclaim/fail-closed
  regressions in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs`.

## Non-goals

External observation of module-load crashes belongs to S2c.
