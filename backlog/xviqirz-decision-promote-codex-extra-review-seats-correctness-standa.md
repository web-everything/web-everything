---
kind: decision
status: open
blockedBy: ["xuybrvq", "x9ipr5i", "xov32df"]
scope: ["we:backlog/xviqirz-decision-promote-codex-extra-review-seats-correctness-standa.md", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-10-21"
tags: []
---

# Decision: promote Codex extra review seats correctness + standards-conformance to verdict seats (parallel); keep claim-accuracy advisory; keep red-team post-accept

Amends ratified decision #2310. Needs /prepare and operator ratification. Operator context 2026-10-21 ~08:55 ET: "Ok" to filing; ~09:00 ET: "Extra seats as advisory was supposed to be temporary as probation, no? Otherwise wasted tokens."

## Evidence (14-day scorecard)

Source: the conveyor run-scorecards store in the daemon self-sync conveyor-state directory. 9,684 rows since 2026-10-07, all Codex, 99.4% completed.

| Lens | Seats | Corroborated by mandatory seats | Non-cosmetic | Later confirmed |
|---|---|---|---|---|
| correctness | 2,754 | 38% (0.55 findings/seat) | 100% | 45 (26% of PRs got a mandatory-confirmed finding) |
| standards-conformance | n/a | 41% | 95% | 29 |
| claim-accuracy | n/a | 17% | ~62% | 78 |
| red-team | n/a | 20% | n/a | 12 |

## Why they are advisory today

- #2310: lens set; blocking only for genuine invariants with no other backstop.
- #3314: claim-accuracy is "advisory, blocks on impact".
- #4194 / epic #3383: extra seats run after the verdict.
- `we:scripts/lib/model-probation.mjs`: trusted is never automatic.

## The gap: probation had no exit rule

Advisory was meant as probation. But `we:scripts/lib/model-probation.mjs` never moves a lens out of ADVISORY_LENSES, so ~280 Codex calls/day ran for 14+ days with no decision. That is wasted tokens.

## Proposal

Part 1 (per lens):
1. correctness becomes a normal verdict seat, run in parallel with the mandatory seats.
2. standards-conformance becomes a verdict seat that blocks only on impact (like #3314).
3. claim-accuracy stays advisory until a precision filter exists (e.g. impact=broken only).
4. red-team stays post-accept.

Benefit: removes the post-verdict extra-seat tail that holds live-review slots.

Part 2 (exit rule for every advisory/probation seat): after N seats or D days (e.g. 500 seats / 7 days), a scheduled report built from the scorecard proposes promote / keep-with-filter / drop, raised to the operator as a ready-to-ratify decision. A seat with no decision by the deadline is paused (tokens stop), never silently continued.

## Question for the operator

claim-accuracy is 17% corroborated. Keep paying for it while a precision filter is built, or pause it now?

## Prerequisites (blockedBy)

- xuybrvq: quota-failure fallback (cap is 80/provider/day vs ~280 calls/day).
- x9ipr5i: scorecard resolution field (precision per lens).
- xov32df: probation-exit report job (Part 2).

## Acceptance

- [A1] **Executable** — the backlog tool shows this card ratified (`status: resolved`, `codifiedIn` set, `preparedDate` set before the ruling), and `we:docs/agent/platform-decisions.md` records the amended #2310 lens rules.

## Test plan

Verify the ratified card with the backlog tool (`we:scripts/backlog.mjs`); the tool is used for verification and does not need modification.

## Non-goals

- [N1] No code in this card; implementation is follow-up work after ratification.
- [N2] Does not change the mandatory seats or red-team timing.

## Edge cases this change must handle

1. **Untrusted text** — n/a: decision card, no input parsed.
2. **Truncated reads** — n/a: the scorecard numbers are quoted from a single read; /prepare re-derives them.
3. **Shared state files** — n/a: no writes to the scorecard here.
4. **Fail closed** — a seat with no decision by its deadline is paused, not continued.
5. **Identity scoping** — n/a: all rows are Codex; Claude seats are not evaluated.
6. **State over time** — numbers are a 14-day snapshot from 2026-10-07; /prepare must refresh them.
7. **Who wrote it** — filed by an agent from operator-approved direction; the operator ratifies.
