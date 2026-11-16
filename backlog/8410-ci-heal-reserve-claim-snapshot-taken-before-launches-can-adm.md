---
bornAs: x32ix3c
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
---

# ci-heal reserve claim snapshot taken before launches can admit one heal beyond the reserved slot (reinforce-later, from ci-heal-starvation audit)

Phase A admits all owed CI-heals before Phase B launches them. The reserve currently sees a pre-launch claim snapshot, so a newly admitted heal can be absent from that snapshot and allow one heal beyond the intended reserved capacity. Count in-pass reservations alongside live claims, and release reservations on held or failed launches. This follow-up owns the remaining cap-bound defect disclosed by PR #6919.

## Acceptance

- [A1] **Executable** — From WE, run the command below. The tests must include a regression named `bounds Phase A admissions by cap plus reserve before claims appear`. With cap C and reserve R, existing live owners plus admitted launches must never exceed C + R, including a wave of four launches and a second daemon pass.

```bash
npm run test:unit -- scripts/lib/__tests__/ci-heal-reserve.test.mjs scripts/operations/__tests__/ci-heal-starvation.test.mjs
```

- [A2] **Must** — Reserve refusal, unreadable claims, and concurrent claim changes cannot increase the bound. Recheck host capacity before every launch; a capacity refusal defers work without spending a repair attempt.
- [A3] **Must** — Test cap 1, cap already full, reserve disabled, reserve already claimed, no live claims, duplicate PR claims, and held/throwing launches. Releasing a reservation allows exactly one replacement and cannot erase another owner's claim.

## Risks and test plan

The current overshoot is bounded at one extra heal; an incorrect reservation release could permit more or starve subsequent passes. Use deferred dispatch promises to keep launches pending while asserting the live-plus-reserved bound, then resolve as success, held, and failure. Add a daemon soak replay with delayed claim visibility and two passes. No HTTP endpoint is added, so request-size, CSRF, and origin controls do not apply.

## Non-goals

- [N1] Do not raise the configured fixer cap or reserve, remove the host recheck, or serialize all launches.

## Edge cases this change must handle

1. **Untrusted text** — Claim metadata is data; do not interpolate it into commands.
2. **Truncated reads** — Incomplete claim evidence refuses new reserve admission.
3. **Shared state files** — Coordinate live claims and in-pass reservations; test simultaneous owners and delayed visibility.
4. **Fail closed** — Missing reserve or host evidence refuses admission without consuming a repair attempt.
5. **Identity scoping** — Key ownership by repository, PR, and owner; duplicates cannot create capacity.
6. **State over time** — Test launch failure, hold, owner expiry, and restart; reclaim only the matching reservation.
7. **Who wrote it** — Only validated dispatcher-owned claims count as reservations.
