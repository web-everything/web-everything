---
bornAs: x46vfgk
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "634"]
blockedBy: ["8633"]
preparedDate: "2026-11-20"
---

# Should WE use workflow profiles, with no expressions and Durable compensation?

Ask: Use the shared UI workflow profile, keep formulas out of flow files, and make compensation an optional Durable feature with visible failure.

## Digest

Prepared, not ratified. F1/F2/F3 research yields one real fork (expressions), two forced ratifies (unknown routing and conditional WE profile pointers), plus supported compensation. #8633(a) decides expressions jointly; this records operator affirmation of delegated R939.

## Fork 1 — Expressions in core

Either/or: unbounded expressions make L2 soundness data-dependent; a restrictive facade cannot restore exact soundness for the entire expression-bearing core.

- (a) **No expressions (default): named classifiers with closed outcomes; only built-in in(stateId).** Finite graph permits exact deadlock, option-to-complete and dead-transition checks. Implement classifiers in CEL/JS/webexpressions behind names; composition over named outcomes can be a feature; decision tables can be a profile; imports generate guards.
- (b) Pin jq/CEL/JSONata in core: compact and familiar. *Rejected:* generally undecidable soundness, differing truthiness, resource limits and injection surface.

Evidence: `2026-11-20-flow-core-model` §4/9/12, `2026-11-20-flow-guards-soundness` §5/9, `2026-11-20-flow-landscape` C1. SCXML null data model and XState named guards are concrete precedents; #4219:80 records R939.

Skeptic: SURVIVES-WITH-AMENDMENT; joint decision with #8633(a), R939 provenance verified. Screen: clear.

## Ratify — explicitly route unknown

**Mandatory unknown outcome routes only to wait, retry, escalate or fail.** Boolean guards are the two-outcome case plus unknown. Excluded: implicit indeterminate that merely blocks, leaving no recovery route. F1 CONFLICT-5 reconciles seat shapes; F3 and engine Gate rules require fail-closed recovery.

Skeptic: SURVIVES-WITH-AMENDMENT; dissolved extra fork, specified recovery. Screen: clear.

## Ratify — conditional WE profile pointers

**If #8633(a), WE Workflow points to core + UI; Lifecycle to core single-active-state flow.** Keep WE source/UX/intents. Separate transition semantics are excluded by the shared-core ruling. Amend #634's ownership line without reopening its rejection of retry/compensation as UX semantics. If #8633(b)/(c), this consequence lapses.

Evidence: `we:src/_data/protocols/workflow.json`, #634:17, F1 §6; context stays UI-profile data, transition events bind OWS lifecycle + from/to/guard/outcome/seq.

Skeptic: SURVIVES; refs verified. Screen: clear.

## Supported by default

- Compensation is an optional manifest feature, not required for engine-durable. Run reverse dependency order (parallel when independent), preserve BPMN scope/waitForCompletion in bindings, expose failure; never promise guaranteed rollback.
- onCompensationFailure continue|halt defaults continue: bounded retries, remaining compensations, FailedToCompensate and intervention item. UI back/undo remains navigation.
- Classifiers are pure declared-input → closed-outcome functions: no effects/state changes; missing implementation means unknown.
- Model incumbent shapes; cite rather than copy ASL/BPMN text. Evidence: `2026-11-20-flow-human-tasks` §1/9 and F2 C1/C5/C8; landscape §5.
- Later operator `standards.flowPluggable` (2026-11-21 02:44): expression languages are guard plugs, new step/guard/profile kinds use registries, adapters declare coverage and emulate/report loss rather than silently dropping it. Name is Flow Wherever, slug flow (#8633).

## What ratifying unlocks

Operator affirmation of R939, WE profile-pointer follow-up and Durable compensation requirements. “D8b yes”, jointly with #8633, takes the defaults.

## Trust boundary and threat model

Flow documents contain data, not executable formulas. Freeze named classifier contracts and adapter coverage; missing evidence never authorizes effects.

Full prep (Standards decisions-prep set):

```text
D8b-x46vfgk.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-flow-core-model.md
2026-11-20-flow-guards-soundness.md
2026-11-20-flow-human-tasks.md
2026-11-20-flow-landscape.md
D8b-x46vfgk.md
```
