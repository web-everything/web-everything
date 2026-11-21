---
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5488", "5785"]
---

# When do GitHub labels stop being the source of truth?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D3 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

## Digest

Make labels display-only per role when that role flips to the Longshore core. This follows own-state-first R551 while bounding rollback and avoiding a fleet-wide cutover.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() §1.1, §2.2, §3–5 describes engine-owned state, a label-writing adapter and tap → shadow diff → flip → delete. The page reports 145 label-reading decision files and about 73 PR-hours/day of gaps; these are source measurements, not re-measured here.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Authority at the role boundary | (a) | (b) | Provisional; needs prep |

## Fork 1 — Authority at the role boundary

Fork-existence: A role cannot simultaneously treat labels and the engine stream as authoritative; disagreement would permit contradictory dispatch decisions.

- (a) **Per role, at its switch (default).** Flip after replay and shadow equivalence; labels then become output.
- (b) All at once at the end. One fleet boundary, but races persist longer and rollback is broader.

Skeptic: Initial filing-stage objection, not an independent pass: Mixed generations could dispatch twice. Require N/N-1 claim compatibility, an authority register and tested rollback; a mode toggle alone is insufficient.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

Role-by-role authority criteria and ci-heal-first migration; the drain remains last.

Operator answers: “D3 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Verify label-reader counts and define authority rollback without resurrecting an obsolete label reader.
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
