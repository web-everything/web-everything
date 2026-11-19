---
kind: story
size: 5
status: active
scaffoldedBy: "auto-clear-human-card"
dateScaffolded: "2026-11-19"
scope: ["we:scripts/conveyor/delegated-clear-human.mjs"]
dateOpened: "2026-11-19"
tags: []
---

# Auto clear-human S1 predicate: Opus re-prep after 4 audit findings

Parked branch lane/auto-clear-human-s1 at 4c41107cda2c142b75edefe8d1dacdb6e01ef20c (original prep doc is in the operator handoff designs folder). S0 shipped separately as PR 7189. Key design question for the Opus re-prep: require merge-gate/review-gate PRESENT and producer-bound (GitHub App id), and keep post-clear head verification. Final audit findings, verbatim: (1) we:scripts/conveyor/delegated-clear-human.mjs:175 — Removes merge-gate/review-gate from required-check enforcement without requiring their presence. Probe confirmed eligibility with required merge-gate entirely missing. (2) we:scripts/conveyor/delegated-clear-human.mjs:170 — Selects gate results by name and timestamp, ignoring producer identity. Probe confirmed a newer success from another app hides a test-gaming hold and permits clearance. (3) we:scripts/conveyor/delegated-clear-human.mjs:266 — Removes post-clear head verification and ignores refresh failure results. Probe confirmed a raced push reports cleared with no refusal; the previous race-detection test was removed. (4) we:scripts/conveyor/delegated-clear-human.mjs:231 — Persists event deduplication before append succeeds. The existing event writer silently returns false on failure, so an undelivered exclusion or decision-owed event suppresses subsequent retries. Earlier rounds fixed: humanRequired guard, resolveRequiredChecks over raw rows by producer identity, main-only scoring base, optional-check failure refusal. Replay at the four manual-clear heads: #7131 would-approve, #7118 size:over-cap, #7117 and #7106 workflow-edit (plus human-required).

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
