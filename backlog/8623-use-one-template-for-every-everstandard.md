---
bornAs: x25bedj
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "5409"]
---

# Use one template for every everstandard?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D6 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Use a common template: numbered MUST/SHOULD requirements, generated schemas, registries, conformance vectors and module maturity. Stable requires two independent passing implementations.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() “Template in 3 lines” and “Template detail” specify spec/, model/, schemas/, registries/, conformance/, bindings/ and examples/. Candidate needs vectors and one passing implementation; Stable needs two. D9 excludes wholesale WE migration.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Normative authoring baseline | (a) | (b) | Provisional; needs prep |

## Fork 1 — Normative authoring baseline

Fork-existence: Each repo needs one canonical source and maturity rule; unrelated per-standard templates cannot simultaneously be the required common baseline. Optional renderers remain compatible.

- (a) **One template for every everstandard (default).** Markdown + BCP 14, JSON Schema 2020-12 generated from model/, RFC 8126 registries, class × level plus features.
- (b) Independent templates per standard. Domain freedom but inconsistent authoring/conformance conventions.
- (c) Require ReSpec/Bikeshed now. Better publication machinery with authoring constraints the source design defers.

Skeptic: Initial filing-stage objection, not an independent pass: A common template could flatten domain differences. Keep module-specific requirements, profiles and bindings extensible; WE retains its authoring format.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

Consistent schema generation and maturity rules; restructure only after D6–D8 settle.

Operator answers: “D6 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Compare real standards templates, verify the two-implementation exit rule and specify source/schema drift checks.
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
