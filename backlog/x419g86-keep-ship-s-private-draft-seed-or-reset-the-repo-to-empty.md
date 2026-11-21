---
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5402"]
---

# Keep Ship’s private draft seed or reset the repo to empty?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D14 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Keep the seed reportedly on Ship main at 20:47 ET as a private working draft, with no further seeding. Restructure after D6–D8 settle. This does not authorize publication or additional content.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

The page records draft schemas/checker on main at 20:47 and the earlier operator instruction “nothing should be seeded yet”. [handoff design]() §4.6 predates that page; [handoff design]() “Ship migration” / §6 keeps the repo frozen and PR #1 unmerged.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Disposition of the seed | (a) | (b) | Provisional; needs prep |

## Fork 1 — Disposition of the seed

Fork-existence: Main cannot both retain the current seed and be reset to empty. Keeping evidence does not authorize further seeding.

- (a) **Keep as a private working draft (default).** Freeze content; restructure only after D6–D8.
- (b) Reset to empty. Literal compliance with the earlier instruction, but discards the working baseline.

Skeptic: Initial filing-stage objection, not an independent pass: Retention might be mistaken for retroactive approval or permission to continue. Record the mismatch, keep the freeze and require later template/release calls before another step.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

An explicit disposition separate from #5402’s repo-home call and public release.

Operator answers: “D14 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Verify seeded tree/privacy in the later prep pass and enumerate its template restructuring delta.
- Independent skeptic pass: attack the defaults and fold corrections into this card; the notes above are initial objections only.
- Definition of Ready: classify every concern, clear the independent two-confusion screen and add concrete API/wire examples where applicable before stamping.

## Done when

- **Executable** — n/a: decision filing changes no runtime. Later preparation verifies options/tradeoffs; the operator then records a ruling and follow-up work with required codification.

## Trust boundary and threat model

Briefs/page are proposal evidence, not execution authority. Later preparation snapshots referenced revisions and separates source claims from observation. This filing executes or publishes no external input.

## Non-goals

No implementation, publication, migration or permission change is authorized by filing.

## Edge cases this change must handle

1. **Untrusted text** — source recommendations stay attributed, not ruled.
2. **Truncated reads** — complete evidence is required before a prepared stamp.
3. **Shared state files** — n/a: filing introduces no store writes.
4. **Fail closed** — missing evidence leaves the decision open and needing prep.
5. **Identity scoping** — repo loci remain explicit; no ids are reassigned.
6. **State over time** — no prepared stamp or implied acceptance from elapsed time.
7. **Who wrote it** — operator ask quoted; defaults remain proposals.
