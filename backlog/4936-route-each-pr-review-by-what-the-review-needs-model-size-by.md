---
bornAs: xv3ce26
kind: epic
status: open
dateOpened: "2026-10-03"
tags: [review, routing]
---

# Route each PR review by what the review needs: model size by risk, a cross-provider seat, tools only when needed

Operator 2026-10-03: more review routing based on what the review needs. Lenses already come from the touch-set (#3309, #3846, review-core-cli shape). This epic adds: model size by risk (Haiku for card-only prose, Sonnet by default, Opus for gate, security or protected-list changes); at least one mandatory seat from a different provider than the PR's author (Codex for Claude-authored, Claude for Codex-authored); tool-bearing seats only when a lens must execute code; and the same risk logic for fixes and CI heals. Gemini and Antigravity are off (seat caps 0), Codex is effectively uncapped.

## What exists (verified on main, 2026-10-03)

- **Lenses from the touch-set.** `we:scripts/review-core-cli.mjs#buildShapePlan` (line 519) gives subject, care level, earned lenses and the mandatory floor. #3309 routes prose to its own lens set; #3846 made review dispatch a router.
- **Extra Codex juror seat for advisory lenses** (#4194), plus opt-in Codex advisory seats in `we:scripts/operations/review-pr.mjs`. None of them can block.
- **Critical-work predicate** `we:scripts/lib/critical-work.mjs#criticalWorkVerdict` (gate, statute, irreversible, security, human-required, high risk; empty scope is critical).
- **Mandatory seats are fixed today**: Claude Sonnet, high effort, tools on, for every PR (`we:scripts/operations/review-pr.mjs:792-795`, `we:scripts/operations/review-job.mjs:259`). Fixes and CI heals skip policy routing (`we:scripts/lib/dispatch-contracts.mjs:1367`).
- **Seat caps**: Codex 5000, which is effectively uncapped; Antigravity and Gemini 0 (review daemon plist; `we:scripts/operations/review-extra-seats.mjs:97`).

## Stories

| Card | What | Blocked by |
| --- | --- | --- |
| 4874 | Pure review-need core: tier, author providers, tool need, cross-provider requirement. Surfaced on `review-core-cli shape --json`. | — |
| 4374 | Mandatory seats take Claude model size and tools from the tier. | 4874, 4815 |
| 4880 | Blocking Codex seat on Claude-authored PRs; an outage parks the accept for a human. | 4874, 4374, 4815 |
| 4973 | `/jury` panel jurors on a PR diff take the tier; every seat records its model. | 4874 |
| 4875 | Fixes and CI heals routed by the same tier: Codex for ordinary repairs, Claude Opus for critical ones. | 4874 |

4815 is the card that open PR #3507 delivers. #3507 edits `we:scripts/operations/review-pr.mjs`, so the two stories that edit that file wait for it. No story touches `we:scripts/lib/jury-core.mjs`, `we:scripts/operations/review-pr-io.mjs` or `we:scripts/review-set-label.mjs`.

## Open decision

- 4772: what stands in when the Codex seat is unavailable. 4880 ships the strict answer, parking for a human. The decision may soften it. Rule it together with 5079 (judge seat, open PR #3771).

## Related, not in this epic

- 4088 (overlay-overlapping reviews run from a `main`-only checkout) is about *where* a review runs, not *what it needs*. It stays under #3383.
- #4377 (allowance gauge) and #4376 (policy dimensions) are future homes for availability and for the tier table as policy.

## Done when

1. Every story above is resolved.
2. A live review of a Claude-authored PR shows a Codex mandatory seat. A card-only PR shows Haiku seats without tools. A gate PR shows Opus seats with tools. An ordinary fix dispatch shows Codex argv. Evidence is linked from each story.
