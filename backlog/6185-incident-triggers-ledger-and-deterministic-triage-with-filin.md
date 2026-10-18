---
bornAs: x334ind
kind: story
size: 8
parent: "6188"
status: open

dateOpened: "2026-10-17"
tags: []
---

# Incident triggers, ledger and deterministic triage with filing (smallest useful, no LLM)

A daemon job reads open health-watch episodes, applies the settle and debounce table (blocking 10 min, degraded 30 min, inefficiency 60 min; a flap never retriggers; a new pass only after the episode closes and reopens with a 6 h cooldown, or when the recurrence count crosses 3 or 10), writes one ledger row per incident key, runs the pure triage (urgent, later, escalate by impact, where impact = blocked items x minutes x episodes in 7 days) and files via file-item (P0 for urgent, normal for later), with dedupe against open cards and PRs. Ships in shadow mode first. Acceptance: (1) unit tests for the rule table, impact bands, debounce (a flap does not retrigger) and dedupe; (2) live: a seeded main-ci-red episode in shadow produces a ledger row and the would-file card text; (3) the setting source is logged per key; (4) with mode enforce on a throwaway repo it files exactly one card per key. Operator decisions 2026-10-17: (a) auto-queue a P0 fix only when a fixed rule matched the cause; LLM-proposed fixes wait for one-click operator approval. (b) the incident pass runs as its own daemon job, like the nightly coroner, not inside the health-watch tick.

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

## Findings (standalone worker, 2026-10-17)

The build-dispatch daemon held #6185 with:

> worker-declined: Not prepared: #6185 — could-not-prepare. The card defines an impact score but leaves its urgent/later/escalate thresholds unspecified. The unresolved choice is whether score alone can authorize P0, or existing P0 eligibility remains controlling ('we:scripts/lib/delivery-priority.mjs:105'). Choosing that would invent policy. Also found existing episode-to-filing machinery at 'we:scripts/conveyor/health-file-request.mjs:133', which preparation must account for. No files changed or stamped; no tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
