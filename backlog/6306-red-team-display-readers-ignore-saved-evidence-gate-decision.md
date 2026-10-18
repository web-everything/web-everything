---
bornAs: xekdulp
kind: story
size: 2
status: active
scaffoldedBy: "fix-5551"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/conveyor/pr-status-label.mjs", "we:scripts/lib/red-team-status-labels.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team display readers ignore saved-evidence gate decisions (NOT READY reason, status labels)

PR #5551 made RULING NEEDED, operator-why and the clear-human ruling read the gate's saved red-team result (savedRedTeamFallback) when the thread has no posted result. Two display-only readers of the same disposition still read the thread alone: redTeamQueueReason (operator-queue evaluatePr / evaluateCeremonyOwed NOT READY reason and pr-status-label's sent-back-red-team status) and planRedTeamStatusLabels (red-team:blocked vs pending). After a saved send-back they omit the red-team reason and show red-team:pending instead of red-team:blocked. Admission is unaffected (the drain hold reads saved evidence). Thread the same lazy readSaved option through these readers; evaluatePr has no repo today, so the caller must supply it.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

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
