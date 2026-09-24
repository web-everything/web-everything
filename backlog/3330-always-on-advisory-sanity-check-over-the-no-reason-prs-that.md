---
bornAs: xay586h
kind: story
size: 5
parent: "3318"
blockedBy: ["3329"]
status: open
relatedTo: ["3867"]
dateOpened: "2026-08-26"
tags: [review, delivery, jury]
scope:
  - we:scripts/lib/review-core.mjs
  - we:scripts/lib/judge-panel.mjs
  - we:scripts/pr-land.mjs
---

# Always-on advisory sanity check over the no-reason PRs that reach no reviewer

22.5% of merges reach no reviewer at all. Replace that zero with one tool-free, diff-only sanity juror on
every no-reason PR — recorded as `observed`, never holding the merge, its findings filing follow-up items
rather than bouncing the PR.

Builds [`#every-pr-gets-a-look-advisory-floor`](../docs/agent/platform-decisions.md#every-pr-gets-a-look-advisory-floor).

## Which PRs

Exactly the set `scoreEscalation` returns `escalate: false` for — no blast-radius or trust-chain path, no
declarative leash, no gate-derivation code, no statute touch, under `thresholds.diffLines`, zero dismissed
pre-PR findings, single-repo. In practice: a demo, a standards doc, a backlog or report edit, a bounded
component change. Measured at **29 of 129 merges (22.5%)** in #3318's baseline table.

Everything that escalates today keeps escalating, unchanged. This item adds a floor under the residue; it
touches no existing route.

## What the pass is — and why it is this small

**One tool-free juror, one round, reading the PR diff and its item card only.** No repo exploration, no
mutation probe, no second opinion. It answers one question: *does this plainly not do what the card says, or
plainly break something visible in the diff?* Not "is this good." Findings cap at three.

The bound is the operator's ratifying amendment and it is load-bearing, not a budget compromise: **this
replaces no review, so its bar is "catch the obvious", not "converge".** A pass scoped to what a full
reviewer would find is a full reviewer, and a full reviewer on 22.5% of merges is a cost and latency argument
this ruling did not make and would not survive.

**It ships on today's `judgePanel` with no dependency on #3158.** `judgePanel` forwards no `allowedTools`, so
every panel juror is `--tools ''`. #3158 files that as a real cost — a tool-free juror cannot run the mutation
probe its mandate demands. For a *deep* reviewer that is a defect. For a diff-only sanity read it is the
specification. Scaling the pass down removes the blocker rather than inheriting it.

## Never holds

The verdict is `observed` (`#3329`) — recorded in the ledger, mirroring no label, invisible to the fold's
disposition. The pass must be structurally incapable of parking: it writes a ledger row and nothing else. No
`review:*` label, no `REVIEW_HOLD_LABELS` member, no path by which a finding becomes a merge condition.

This is what makes the pass free of the #2606 latency cost that killed the random sampler (#2631): a park
stops the merge, and a review that cannot park cannot stop it.

## Provider, async footing, and scope (folded in from #4031, 2026-09-24)

- **The floor juror defaults to a non-Claude provider** — Codex is allowed for tool-free judging (rule 7 of
  `#delegation-trial-record-graduation`), Gemini also possible — so the floor costs ~no Claude usage. A
  different provider from the PR's builder is preferred, never required (rule 7).
- **The async/non-blocking footing above is now statute, not just this item's own design**:
  `we:docs/agent/platform-decisions.md#delegation-trial-record-graduation` (rule 7) carries the same "runs
  asynchronously, off the landing path — never holds or delays a merge" language, added ratifying #3867
  (operator, 2026-09-24, PR #2583).
- **It applies to every PR that lands in the no-reason set** — Claude-built and delegated-provider-built
  alike. The floor is not special-cased by who built the PR, only by whether the PR reached no reviewer
  (`escalate: false`). Until this item ships, Claude's own PRs lack this floor the same way a delegated
  build's do.
- **Cost-baseline correction:** #3313's "~$12.50 across 29 PRs" figure equals 29 × #3318's ~$0.43/PR
  full-lens baseline — i.e. it is the **full-lens** cost, not this floor's. The floor's own real cost is
  still unmeasured; closing that gap is exactly the *Measure it* section above, not a separate task.

## The teeth

A review nobody must act on rots into noise. So a finding above a stated severity **files a follow-up backlog
item against the merged PR**. It never re-opens the PR, and it never bounces it.

Fixing forward rather than preventing is a real cost, stated rather than hidden. It is acceptable *here*
precisely because of which PRs these are — small, single-repo, no sensitive paths — and it would not be
acceptable for any escalating class. That is the whole reason the floor is scoped to the no-reason set.

## Measure it

#3318's baseline records ~$0.43/PR for a full single-lens run. This pass should land well under that, but the
figure is unmeasured. **Record cost and wall time for the first ten runs** and report them to #3318 — the
program's front-A metric set is the consumer, and a sanity check whose cost approaches a real review's has
failed its own premise.

The rows are also the corpus #3315 needs. The sampler this replaces would have produced a trickle of them;
this produces all of them.

## Not in scope

- **The `observed` verdict itself** — `#3329`, which this is blocked on.
- **Changing any escalation threshold or route.** The rubric is untouched.
- **Adjudicating the findings.** Whether an `observed` finding was *right* is #3315's per-category
  false-positive meter, not this pass.

## Done when

1. **Executable** — a test proving a PR scoring `escalate: false` gets an `observed` ledger row and **no**
   `review:*` label, and that the pass's own findings cannot produce a `REVIEW_HOLD_LABELS` member on any
   path. `npx vitest run review-core` green.
2. Cost and wall time for the first ten runs appended to #3318's baseline table.
3. `npm run check:standards` passes.
