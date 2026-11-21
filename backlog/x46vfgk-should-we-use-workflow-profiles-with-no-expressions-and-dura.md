---
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "634"]
---

# Should WE use workflow profiles, with no expressions and Durable compensation?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D8b (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Affirm three compatible defaults: WE Workflow/Lifecycle become profiles or pointers; the shared core has no expression language; Durable includes compensation. WE keeps its repo and format.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() §6 defines named closed-outcome guards, identifies R939 as delegated rather than operator affirmation, and puts BPMN/saga compensation in Durable. WE profile adoption amends the #634 line and requires a WE ruling.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Supported by default

**Yes to all three (default).** (a) WE profiles/pointers; (b) no expressions in core, only named closed-outcome classifiers; (c) built-in compensation/undo steps in Durable.

Why no fork: The three concerns can all hold at once.

Skeptic: Initial filing-stage objection, not an independent pass: A classifier plugin could smuggle in an evaluator; compensation could promise impossible global rollback. Define classifier boundaries and compensation failure semantics; UI back/undo is distinct from durable saga compensation.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

An explicit WE profile ruling and operator affirmation of R939, plus Durable compensation requirements.

Operator answers: “D8b yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Audit #634/R939 lineage, inspect current guard APIs and show closed outcomes; survey compensation failure/retry semantics.
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
