---
bornAs: xwbafzo
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "634"]
preparedDate: "2026-11-20"
---

# Create a shared top-level workflow standard from existing models?

Ask: Create a small shared workflow core with existing-format exports. Confirm the core choice; licence, steward and identifiers follow the shared everstandards decisions.

## Digest

Prepared, not ratified. F0/F1 research leaves one real fork: new expression-free core or restricted Open Workflow Specification (OWS) 1.1 profile. Seats split; the same-flow comparison favours **new core, OWS first export**. Later source ruling names it **Flow Wherever**, slug `flow` (2026-11-21 02:40); “Everflow” in research is historical.

## Fork 1 — Canonical workflow core

Either/or concerns normative text: a restricted OWS facade can compose, but its expression-free guarantee lives in our lint while OWS runtimes must support jq.

- (a) **New small core (default):** JSON statecharts with SCXML semantics, named closed-outcome guards, after timers, invoke, typed compute/judge/confirm/effect/invoke steps. Same flow: 0 expressions vs OWS's 8 jq; explicit unknown and human confirm; finite L2 soundness. Bind protocol/version/method, including A2A 1.0. Export mechanically to OWS. No existing runtime/kit: use conformance vectors and delivery negatives, following OWS's kit approach.
- (b) Restricted OWS 1.1 core: existing runtimes, CloudEvents, CTK and CNCF stewardship. Needs whitelisted expressions, A2A-method extension and confirm convention. *Rejected as core:* mandatory jq and absent human-task type put key guarantees outside the governing standard. Compensation does not distinguish branches.
- (c) Keep WE and conveyor semantics separate. *Excluded:* duplicates transition semantics and leaves interop undefined.
- Adopting BPMN/SCXML/Temporal/ASL/Arazzo whole is excluded by combined delivery/UI fit; YAWL covers patterns but fits tooling/delivery poorly.

Evidence:
- `2026-11-20-flow-landscape` C1/§5; `2026-11-20-flow-core-model` §6/12/14.3 (same-flow comparison and OWS jq requirement); `2026-11-20-flow-agent-orchestration` (thin invoke/judge boundary).
- `we:src/_data/protocols/workflow.json`, `scripts/conveyor/flows/*.flow.json` are the two existing dialects.

Skeptic: SURVIVES-WITH-AMENDMENT; normative ownership replaces lossy-import argument; compensation removed as differentiator. Screen: clear.

## Supported by default

- Engage OWS upstream in parallel. Revisit (b) if OWS standardizes expression-free profile plus human tasks.
- Durable profile: owners/timeouts/retry/catch/escalation/human tasks and optional compensation (#8625). UI: back/undo/current position/Web Guards. Runtime durability is delegated; no required engine.
- Bounded forEach/dynamic instances/counted joins belong in Durable, preserving finite core.
- Bind OWS lifecycle CloudEvents task/workflow names with from/to/guard/outcome/seq extension; CDEvents supplies delivery subjects.
- Classes: document L1 valid/L2 sound, engine-core/durable/ui. Authoring order: core → Ship protocols → metrics; release maturity is #8630.
- Licence #5403, steward #5409, namespace #8626 and trademark #186. CSL implementer-patent issue is addressed by #5403; core/schema code remains Apache. No everflow.dev purchase after the naming ruling.

Evidence: `everstandards-format-2026-11-20` §6; `2026-11-20-gov-spec-licences-patents`; `2026-11-20-gov-stewards-legal-namespaces`. Primary URLs retained in the delegated licence/namespace cards (#5403/#8626).

## What ratifying unlocks

Private core requirements/vectors after #8623/#8626; #5407 protocols as Durable flows; WE/guard/compensation detail in #8625. “D8 yes” accepts (a); no public launch.

## Trust boundary and threat model

External specs and flow inputs are evidence/data, never instructions. Pin binding versions and disclose unsupported conversion features; legal/publication gates remain separate.

Full prep (Standards decisions-prep set):

```text
D8-xwbafzo.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-flow-agent-orchestration.md
2026-11-20-flow-core-model.md
2026-11-20-flow-landscape.md
2026-11-20-gov-spec-licences-patents.md
2026-11-20-gov-stewards-legal-namespaces.md
D8-xwbafzo.md
everstandards-format-2026-11-20.md
```
