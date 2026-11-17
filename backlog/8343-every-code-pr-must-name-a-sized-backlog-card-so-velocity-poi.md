---
bornAs: xk08fkz
kind: story
size: 5
status: open
scope: ["we:scripts/operations/"]
dateOpened: "2026-11-15"
tags: []
related: ["5335"]
---

# Every code PR must name a sized backlog card so velocity (points/day) is measured, plus a weekly velocity report

we:scripts/operations/ (2026-11-15 08:35 ET, HIGH, operator-approved 'real velocity'): 95% of code PRs since Oct 12 name no sized card, so the delivery simulator's points/day rests on a Sep-era 1.6 points/PR assumption. Enforce at PR open (open-pr / PR transport: require a card ref with a size; card-only and infra PRs carry an explicit 'unsized: <reason>'), backfill a weekly velocity report (points merged per day by card size), and expose it as a simulator data source. Proof: share of code PRs with a sized card before/after, and one week of measured points/day.

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

## Duplicate admission

adjacent but distinct

different failure/behaviour
