---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Complexity + criticality as two first-class, configurable signal sets for cards and PRs

[held entry 264] (operator 2026-10-12, held — after card 263) Complexity + criticality as two first-class, configurable signal sets for cards and PRs. Start from existing signals (deriveCareLevel inputs, size, kind, fix rounds). Later add the full catalogue projects/agile methods use, each a named, weighted, opt-in signal in settings: story points / t-shirt size, estimatedLoc, files/modules touched, novelty (new design vs routine), dependencies / blockedBy depth, uncertainty / spikes, technical-debt area, test coverage of touched code, churn/hotspot history, defect history, business value / priority (WSJF, MoSCoW, cost of delay), risk (security, data, permissions, cross-repo, user-facing), reversibility, DoR/DoD readiness. Complexity → tier (vendor/model/effort); criticality → review rigor + human gate. Per-project weights via the settings cascade.

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
