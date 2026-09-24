---
bornAs: xohvzus
kind: decision
parent: "3383"
relatedTo: ["3690", "3850", "3313", "3949"]
status: resolved
dateOpened: "2026-09-22"
dateResolved: "2026-09-24"
codifiedIn: "docs/agent/platform-decisions.md#delegation-trial-record-graduation"
preparedDate: "2026-09-23"
preparedAgainstSha: "97945ac8c1a274ecd6f0c6da1816a54c00308be0"
relatedReport: reports/2026-09-23-delegation-below-spot-check-grounding.md
tags: [delegation, supervision, graduation, validation, decision-prep]
---

# Decision: should a delegated vendor graduate past spot-check to a lighter or absent independent review after sustained high confidence — reopens ratified rule 7 of #delegation-trial-record-graduation

**Ruled 2026-09-24 by the operator (Nicolas Gilbert): NO.** No supervision level below `spot-check` —
`SUPERVISION_LEVELS` stays at `full` + `spot-check`, as recommended. One operator amendment: the
`spot-check` pass is **asynchronous and non-blocking** — it runs off the landing path (it never holds or
delays a merge; it may run after land), records its verdict, and a finding files a follow-up item. The
operator also noted, separately, that Claude's own PRs currently lack this floor because #3330 is still
open. Codified in
[we:docs/agent/platform-decisions.md#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation).

## Digest

**Validation gate, recommended verdict: NO — keep rule 7 as ratified.** The operator asked (2026-09-22)
whether a delegated vendor with a long, clean record at `spot-check` could go one rung lighter, or lose the
independent check altogether. `spot-check` is **already the delegated PR's own review, never below the
floor every PR gets** ([#every-pr-gets-a-look-advisory-floor](/docs/agent/platform-decisions/#every-pr-gets-a-look-advisory-floor),
#3313). Going lower would check a delegated vendor *less* than Claude's own work and switch off the evidence
that demotes it. The "absent" form was already rejected in #3690 Fork 5 (b). Prior art drops the per-item
look by **kind of change**, never by a producer's record.

Grounded in the published research topic
[/research/delegation-below-spot-check/](/research/delegation-below-spot-check/) and
`we:reports/2026-09-23-delegation-below-spot-check-grounding.md`, which extend the #3690 survey
([/research/delegation-graduation-and-supervision-tiers/](/research/delegation-graduation-and-supervision-tiers/)).

## What you're deciding

One call: **do we amend rule 7 of
[#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation) to
add a supervision level below `spot-check`?** Recommended: **no**, with a one-sentence note added to rule 7
so the question is not re-filed.

## Why this isn't a classic fork (and is still a decision)

- There is no rival design to weigh. The card proposes one candidate — a third, lighter level — and asks
  whether to adopt it. That is a go/no-go on a candidate: the validation-gate shape, not a `## Fork N`.
- Its "no independent check" form is not open at all. It is the excluded branch of #3690 Fork 5, already
  rejected against #3313 ("the capacity floor is never zero"). It is stated here as a forced invariant, not
  re-decided.
- Merit is genuinely open for the "lighter tier" form: the operator raised it, and whether a shallower
  look than the floor exists is a real question. So this is a merit call, not ordering.

## The code and statute it touches

- `SUPERVISION_LEVELS` has exactly two values (`we:scripts/lib/provider-routing.mjs:137-140`).
  `selectSupervisionLevel` reaches `spot-check` only on its last branch (`:745`); every other branch returns
  `full` (`:736`, `:739`, `:742`).
- Rule 7 defines the `spot-check` pass **by reference** to #3313's floor: one tool-free juror, one round, the
  diff and the item card, capped findings, non-blocking (`we:docs/agent/platform-decisions.md:4975-4983`).
- #3313 gives that same floor to every PR that trips no escalation reason
  (`we:docs/agent/platform-decisions.md:4328`); a PR that trips one gets more than the floor. Its bar is "catch the obvious", measured "against zero".
- Rule 6 makes demotion computed and immediate, and puts the repo axis above the triple axis
  (`we:docs/agent/platform-decisions.md:4967-4974`).

## Context & prior-art delta

"Lighter than `spot-check`" can only mean one of four things, and each is already placed:

| Candidate | Meaning | Where it already stands |
| --- | --- | --- |
| Absent | no independent pass for the graduated triple | rejected: #3690 Fork 5 (b); #3313 "never zero" |
| Sampled | review 1 in N of the triple's diffs | rejected: #3313 "never a random sample of a few" |
| PR-level review only | no delegation-specific pass; the delegated PR's own review clears it | this is already what `spot-check` is — a delegated PR is stamped by `we:scripts/pr-land.mjs --delegation` and its trial row is written on `review:accepted` (`we:scripts/review-set-label.mjs:1024-1043`); not a lower level |
| Shallower juror | cheaper model, fewer findings, shorter card, or several diffs batched into one juror call | not a level: it is the floor's own depth/cost dial, changed for **every** PR on #3313's anchor, never per producer |

The research questions the card listed, answered:

1. **What evidence bar would justify going below `spot-check`?** None that the record can supply. A streak
   measures how often the independent pass found nothing. Removing the pass removes the thing being
   measured, so no streak length can justify it. This is #3690 Fork 5's "sampler with the score as its
   sampling key".
2. **Was "never goes away" a considered floor?** Yes. #3690 Fork 5 (b) was the card's own earlier default
   ("drop the independent pass entirely at spot-check"). Its prep skeptic refuted it against #3313, and the
   operator ratified (a) with no amendments on 2026-09-21. A tier *between* the floor and zero was never
   named, because the floor is already the shallowest non-sampled look.
3. **Security cost of a path with only the orchestrator's read?**
   - Demotion becomes unreachable. A confirmed miss (rule 3's hard veto) is found mostly by the independent
     pass. Without it the record stops receiving misses, so rule 6's computed demotion cannot fire and
     promotion turns one-way.
   - Positive controls stop. Rule 4's `informative` field needs "independent review found a real problem".
     Rule 5's re-graduation bar reads the same field.
   - The remaining read is not independent. The orchestrator chose to delegate;
     [#agent-convergence-independent-validation](/docs/agent/platform-decisions/#agent-convergence-independent-validation)
     clause 1 puts independence on "a distinct fresh validator".
   - `we:scripts/codex-direct-task.mjs` exits 0 on timeout, on a gate failure and on an unbidden commit
     (#3690 Fork 5 crux), so a missed field read is silent.
   - **Known gap — this breach already exists at `spot-check` today, in code.**
     `we:scripts/review-set-label.mjs:1030` writes a trial row only while `!isDelegationTripleGraduated(...)`,
     and always as `outcome: 'landed'`, `findings: null`. So a graduated triple stops generating rows, and no
     row ever records a miss. Separately `we:scripts/conveyor/delegation-trial-gate.mjs:15` infers
     "informative" from free-text `findings` (rule 4 forbids it) and `:23` hard-codes `streak >= 5` instead
     of reading `DEFAULT_BACKDOWN_THRESHOLDS` (rule 1). This makes the case for "no" stronger, not weaker:
     the floor's demotion signal must be *restored*, not removed further. Filed as a build:
     [#3949](/backlog/3949-delegation-trial-logging-stops-once-a-triple-graduates-and-n/)
     (independent of this verdict — it is owed under rules 1, 4 and 6 either way).
4. **Composition with the repo axis?** No clash: a third level would sit on the triple axis, and rule 6's
   "repo-level `none` is never overridden" would still win. One naming hazard: the natural name for "no
   check" on the triple axis is `none`, which on the repo axis means the opposite (no autonomy, most
   checking). The repo axis has no code yet, only prose.

**Known occurrences — prior art** (full table and links in the report):

- **Record moves depth, never coverage to zero:** ANSI/ASQ Z1.4 / ISO 2859-1 reduced inspection (smaller
  sample, one rejected lot → back to normal); Google (every change needs an LGTM).
- **Record removes coverage only as a sampler:** ISO 2859-3 skip-lot — the kind #3313 already rejected.
- **Where the per-item look is dropped, it is keyed to the change class, not the producer:** Renovate /
  Dependabot automerge (lockfiles, devDeps, digests); Chromium Rubber Stamper (clean reverts, cherry-picks,
  benign files; "never provides OWNERS approval"); SLSA's "Trusted Robot" exception is a named governance
  act, not earned by a streak.
- **AI coding agents, Sept 2026:** GitHub Copilot coding agent, OpenAI Codex, Devin and Claude Code review all
  keep a required review before an agent PR merges.

**The WE delta.** The proposal keys lighter checking to *who built it*. Prior art keys it to *what kind of
change it is*. The first breaks the measurement loop rules 3–6 depend on. The second does not, but it is a
builder-neutral amendment to #3313, not to rule 7.

## Recommendation — NO (do not amend rule 7)

- **Verdict: no.** Keep `SUPERVISION_LEVELS` at `full` and `spot-check`. Keep rule 7's "shallower, never
  absent" floor as ratified.
- **What lands if ratified:** one sentence appended to rule 7 of
  `we:docs/agent/platform-decisions.md#delegation-trial-record-graduation`: *"A level below `spot-check` —
  lighter or absent — was proposed and declined (#3867): `spot-check` is the delegated PR's own review,
  which is never below the #3313 floor, and a producer's record never exempts a PR from that floor."* `codifiedIn` = that anchor.
- **What does not change:** no code; the `spot-check` pass keeps tracking #3313 by reference, so if #3313's
  floor is ever made cheaper for every PR, `spot-check` gets cheaper with it automatically.
- **Re-open trigger (concrete).** Re-open only if one of these happens:
  1. #3313's floor is itself amended to allow a per-PR "no look" for some class of change. Then the question
     becomes "does that class exemption apply to delegated triples too", asked on the #3313 anchor, not on
     rule 7.
  2. A second independent signal appears that can confirm a delegated triple's misses *without* a per-diff
     review — for example post-land defect attribution back to the triple, measured and shown to catch what
     the floor catches. Then rule 6's demotion no longer depends on the floor, and the security argument in
     question 3 above must be re-run.
- **Not pursued here (pointer only, not filed):** if the goal is lower review cost, the lever the prior art
  supports is a **change-class** exemption from the #3313 floor for every builder (pure reverts, lockfile-only
  diffs). That is a separate candidate on #3313's turf.

**Statute check.** The drafted note restates rule 7 and #3313; it adds no new test and no collision.
**Authority:** #every-pr-gets-a-look-advisory-floor (#3313) and rule 7 itself. **Supporting only, by analogy
or lineage:** #build-lane-self-review-non-zero-floor (#2828, Layer 1; reached through #3313's own
"extends"), #model-probation-graduation-criteria clause 4 (#3654 — a trial-bar floor for identities, not
review depth), #agent-convergence-independent-validation clause 1 (#2398 — written for the drain's
convergence loop).

**Skeptic:** SURVIVES-WITH-AMENDMENT (all folded in). "No" held on every axis. Amendments: (1) added the missed "PR-level review only" reading and batching as a depth dial, both already covered; (2) found the demotion signal is *already* broken at `spot-check` in code (`we:scripts/review-set-label.mjs:1030`, `we:scripts/conveyor/delegation-trial-gate.mjs:15,23`) — named above and filed as #3949; (3) reworded the codified note so it does not overstate #3313 (the floor binds PRs that trip no escalation reason); (4) downgraded #2828, #3654 cl. 4 and #2398 cl. 1 from authority to supporting; (5) fixed two line refs.

**Screen:** clear — the ruling sits on statute (rule 7), with the enum cited only as grounding; the merit question ("a streak cannot justify removing the instrument that produces the streak") survives stripping timing and cost.

Predicted touch-set of the work a "no" ratification authorizes: `we:docs/agent/platform-decisions.md` (the one-sentence note on rule 7). Care estimated `high` — it edits statute.

### Review jury (provisional — pre-registered #2638)

Care level: `high`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| correctness#2 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| security#2 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| simplicity#2 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| standards-conformance#2 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
| claim-accuracy#2 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

## Status

Operator revisited via `/prepare 3867` (2026-09-23). Prepared as a validation gate; the call is the
operator's at `/next decision`.

## Done when

1. **Executable** — `grep -rn "declined (#3867)" docs/agent/` returns a line inside the
   `#delegation-trial-record-graduation` anchor (fails today, passes once the ratified note lands). On a
   "go" verdict instead, a new `SUPERVISION_LEVELS` value and its tests land under a separately-filed build.
