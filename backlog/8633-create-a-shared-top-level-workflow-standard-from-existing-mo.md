---
bornAs: xwbafzo
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "634"]
---

# Create a shared top-level workflow standard from existing models?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D8 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Create a small shared top-level everstandard, working name Everflow: SCXML statechart semantics in JSON, typed step kinds, Durable and UI profiles. Spec order: flow core → Ship protocols → metrics.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() §6 scores Serverless Workflow, BPMN, SCXML, Temporal, Arazzo, FBP and others. Its verdict is that none fits delivery and UI together. WE Workflow/Lifecycle and `we:scripts/conveyor/flows/` are existing statechart-family consumers.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Canonical workflow model | (a) | (b) | Provisional; needs prep |

## Fork 1 — Canonical workflow model

Fork-existence: Ship and WE need one shared semantic baseline; incompatible canonical transition semantics cannot both govern it. Exports to incumbent models remain compatible bindings.

- (a) **Create the shared top-level core (default), working name Everflow.** SCXML semantics; named closed-outcome guards; no core expressions; compute/judge/confirm/effect/invoke steps with typed ports. Operator chooses name/repo.
- (b) Adopt one incumbent whole: Serverless Workflow, BPMN, SCXML, Temporal-style execution or Arazzo. Mature tooling but a weaker fit to one domain in the source evaluation.
- (c) Keep WE Workflow and conveyor flows separate. Avoids a new standard but duplicates semantics and leaves interoperability undefined.

Skeptic: Initial filing-stage objection, not an independent pass: This may reproduce XState or Serverless Workflow with less tooling. Keep the core thin and test mappings against both existing corpora before minting; the source scores are not independent validation.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


Supported by default: Durable supplies owners, timeouts, retry/catch, escalation, human tasks, compensation and event triggers; UI supplies back/undo, current position and Web Guards. Typed ports express assumes/provides/removes. Flow-document conformance is L1 valid / L2 sound, with separate engine-core, engine-durable and engine-ui classes. These are proposed profiles, not a mandate for one runtime.

## Consequences / what ratifying unlocks

Flow-core specification first; Ship protocols become Durable flows; D8b separately rules WE profiles. Exports target Serverless Workflow, ASL, XState and BPMN; Arazzo covers API calls.

Operator answers: “D8 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Validate scoring against primary specs; map both flow corpora, demonstrate typed ports/transition examples and soundness, and settle name/repo.
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
