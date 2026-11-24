---
bornAs: xho1snv
kind: story
size: 3
parent: "2804"
status: open
scope: ["plateau-app:tests/visual/real-route-fidelity.spec.ts"]
dateOpened: "2026-11-23"
tags: []
related: ["2811"]
---

# 2811 oracle: failing check first

File the real-route conformance oracle first and show it RED against the current /console-board, with no deferral; split out of #2811 so the oracle is not parked behind PD-BOARD.

## Acceptance

- [A1] **Executable** — the assembled-route conformance test (`plateau-app:tests/visual/real-route-fidelity.spec.ts`) runs and, mounted on the CURRENT `/console-board`, **must FAIL** (empty center, duplicate chrome, missing legend, wrong pool template). It goes green **only once the board is actually fixed** — so it doubles as the acceptance gate for the eventual console-board remediation.
- [A2] Must render the **real route in the host shell**, both themes, empty + overflow seeds. No `?demo=1`.
- [A3] `render-slice`: resolve gates on the rendered red→green proof, human-reviewed. **Do NOT auto-resolve on tests-green alone.**
- [A4] No deferral: this card is open and is not behind PD-BOARD; #2811 keeps only the remaining work (the final-route green proof) and is blockedBy this card (copied from #2811's Conveyor guardrail, 2026-11-23 audit fix).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

oracle split out of #2811

#2811 itself is parked and keeps only the remaining green-on-final-route work
