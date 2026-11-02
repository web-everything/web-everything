---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-result*.mjs", "we:scripts/operations/coroner-rounds.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Red-team findings carry no machine-readable break CLASS, so R115 (3 consecutive new classes stops the rounds)

MED priority hint. 384. (coroner-1028, held) Red-team findings carry no machine-readable break CLASS, so R115 (3 consecutive new classes stops the rounds) is hand-counted by the judge and the coroner. Eight PRs reached 3 or more classes in one day (#6008, #5964, #5972, #5982, #5979/#5980, #6017, #5990, #6003), up from four the night before; each cost 6 to 12 rounds before a design stop.      Fix idea: the red-team result schema adds a normalized `breakClass` (one of a short list: identity, lifecycle, admission, inventory, classification, path, trust boundary, other) per confirmed finding; the judge's round-cap step and the coroner read it, and the gate sends the PR back to design on the third distinct class.     Evidence: judge notes 10-28 01:00, 01:26, 01:56, 13:05, 13:24 ET; changeRequests (hints are line-based only). Scope: we:scripts/lib/red-team-result*.mjs, we:scripts/operations/coroner-rounds.mjs. Size 5.

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
