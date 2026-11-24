---
bornAs: xvbh2rb
kind: story
size: 8
parent: "2804"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: the board is mounted in the new shell (plan step PD-BOARD), so the real-route oracle has a final route."
dateParked: "2026-11-22"
blockedBy: ["2809", "2810", "8703"]
scope:
  - plateau-app:tests/visual/real-route-fidelity.spec.ts
dateOpened: "2026-08-01"
dateStarted: "2026-08-02"
tags: [plateau-loop, conveyor, ui-fidelity, plateau-app, render-slice, human-verify, slice-uifg]
---

# Real-route conformance test (plateau-app)

A conformance test (`plateau-app:tests/visual/real-route-fidelity.spec.ts`) that rides the plateau-app test run:
renders the assembled route via the harness [#2809] and cross-checks the frozen webcase required-set +
geometry [#2810] + singleton-chrome-by-role + theme. Orthogonal to the structural unit suite.

## Conveyor guardrail — self-proving, human-verify
**Do NOT auto-resolve on tests-green alone.** This is the assembled-route oracle; it must prove it catches the
real failure:

- Mounted on the CURRENT `/console-board`, the conformance test **must FAIL** (empty center, duplicate chrome,
  missing legend, wrong pool template). It goes green **only once the board is actually fixed** — so it doubles
  as the acceptance gate for the eventual console-board remediation.
- Must render the **real route in the host shell**, both themes, empty + overflow seeds. No `?demo=1`.
- `render-slice`: resolve gates on the rendered red→green proof, human-reviewed.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: the board is mounted in the new shell (plan step PD-BOARD) so the real-route oracle has a final route. Parked, not blockedBy, because the trigger is a plan step.

Acceptance order (audit fix): the failing oracle is the FIRST acceptance item and is not deferred. The real-route conformance check must be written and shown RED against the current `/console-board` before any board remediation (#2834) starts. Only the remaining work (running it on the final route in the new shell, red to green) waits on the PD-BOARD trigger.
