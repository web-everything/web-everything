---
bornAs: x5wnfcg
kind: story
size: 5
status: open
scope: ["we:scripts/settings/", "we:scripts/lib/"]
dateOpened: "2026-10-09"
tags: []
---

# Policy cascade: delivery policies resolve standard default → platform preference → tool override

Operator 2026-10-09: integration strategies (serial/batched merge queue, staging, auto-revert) and every delivery policy decided this week are team practices — Ship Evermore defines them, Platform Forever holds the team preference, Longshore settings only override. Build one resolver (we:scripts/settings/) that reads tool/project override, else a platform-level preference file, else the standard default; migrate today's policies (merge-queue mode, batch size, priority classes, interrupt vs reserve, revert-red mode, quiet hours, fixer caps) to declare a standard default and a platform key. Needs prepare (where the platform preference lives before Platform Forever exists).

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

## Initial platform preference (our team practice, chosen 2026-10-09)

Operator: "As for our preference for now, I trust you to choose the best value." Values chosen on today's evidence; each is a starting point to revisit with data:

| Policy | Our value | Why |
|---|---|---|
| Merge queue freshness | middle-ground: re-test if main gained any code since the pass; non-code (backlog/, docs/) moves count as fresh; max pass age 30 min | catches semantic clashes like #4547+#4453 without slowing card-only merges |
| Merge queue batch size | 1 (batching later) | simple; revisit when queue wait > 30 min |
| Auto-revert of red-main culprit | suggest-only (off) | revert is outward-facing; the safety net already assigns one owner |
| Builder pause on red main | on | stops building on a broken base |
| Drain while main red | only P0 main-fix + proven-green PRs land | contain the break |
| Priority class | derived from facts + operator override; aging +1 after 8 h, never into P0 | ruled 2026-10-08 |
| Urgent capacity | interrupt (reserve 0); only P0 interrupts; never kill a running test | ruled; measure frequency |
| Ultrafast model mode | P0 only, off by default, daily cap | ruled |
| Fixer cap | 8, CPU-idle guard 8% | measured headroom 2026-10-08 |
| CI-heal reserve | 3 | ruled |
| Revert-red check | warn; enforce only after the #4535 follow-ups land | false flags found in review |
| Class sweep evidence | warn | new |
| Review round budget (accept with cards) | K=3, shadow until scoped re-review proves out | replay showed ~0 rounds saved so far |
| Binding prior round | shadow only | replay showed ~0 gain |
| Pre-PR review | advise | not yet hardened |
| Quiet hours | 22:00–07:00 ET; only main red and daemon down >30 min break through; one morning digest | ruled |
| PR comments | on change or action only | ruled |
| Prepare-ahead window | 6 | operator reset 2026-10-09 |
