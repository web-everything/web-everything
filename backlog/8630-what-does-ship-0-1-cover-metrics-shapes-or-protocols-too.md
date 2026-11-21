---
bornAs: xcwzfo3
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407"]
---

# What does Ship 0.1 cover: metrics shapes or protocols too?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D13 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Keep Ship 0.1 to delivery metrics shapes—capacity, planning and readout—with work-item, role, handoff and verdict protocols in 0.2+. Freeze until Plateau’s delivery view reads live data through it (committee C3).

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() §4.2–4.3 lists settings, calibration, plan, readout, levers, forecast and promises, plus L1–L3 classes. [handoff design]() “Ship modules” / §6 distinguishes release scope from spec order: flow core → protocols → metrics.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — The 0.1 compatibility promise | (a) | (b) | Provisional; needs prep |

## Fork 1 — The 0.1 compatibility promise

Fork-existence: A version cannot promise metrics-only scope and also include unsettled protocol obligations. Later modules can coexist in later versions.

- (a) **Metrics only in 0.1 (default); protocols in 0.2+.** Retain C3’s live Plateau consumer freeze.
- (b) Shapes and protocols together. Broader first release, but binds 0.1 to unsettled flow/protocol contracts.

Skeptic: Initial filing-stage objection, not an independent pass: Metrics-first could freeze engine-specific shapes. Retain the C3 proof, follow D8’s authoring order and document pre-1.0 migrations; release numbers do not override dependencies.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

A bounded release target and live-consumer acceptance condition; #5407 protocols remain tracked.

Operator answers: “D13 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Reconcile C3 with live-data needs; inspect schema/engine coupling and map 0.2 protocol dependencies.
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
