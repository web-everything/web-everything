---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:scripts/lib/review-ci-gate.mjs", "we:scripts/lib/review-timing.mjs", "we:scripts/lib/review-ci-gate-io.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Harden CI-evidence gates left from PR 7160 audit (F1, F3-F7)

PR 7160 round-2 judge ruling: pre-existing gaps. F1 we:scripts/merge-ai-prs.mjs revalidation CLEAN path ignores completeness/row heads/extra required checks. F3 we:scripts/conveyor/ci-heal-escalation-mark.mjs not-a-ci-break should refuse on unproven rows. F4/F5 we:scripts/lib/review-ci-gate.mjs validate before collapsing, reject contradictory rows and status-less aggregates. F6 we:scripts/lib/review-timing.mjs verify-marker should keep malformed refusals. F7 we:scripts/lib/review-ci-gate-io.mjs dedupe runs by id and statuses by context before comparing to total_count.

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
