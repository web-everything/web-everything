---
bornAs: x6hbdjq
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5405", "186"]
---

# Which namespace and domain identify schemas, events and predicates?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D11 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Choose a public namespace before publication. The page leaves the choice to the operator; private relative ids allow drafting without claiming a domain. No particular public domain is recommended by the source.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() “Operator decisions” / “Ship migration” and [handoff design]() §4.1/4.5 tie identifiers to #5405 and #186. The brief says shipevermore.dev was free on 8 October but not rechecked; this is not current clearance.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Public identifier authority | (a) | (b) | Provisional; needs prep |

## Fork 1 — Public identifier authority

Fork-existence: One released schema/event/predicate needs one canonical namespace; competing canonical identities require aliases. Relative private ids are a holding state, not a second public authority.

- (a) **Keep ids relative while private; operator chooses after checks (page position, no domain pick).** Gate publication on a resolved namespace.
- (b) Choose one shared everstandards domain now. Common stewardship, pending ownership/availability and legal checks.
- (c) Use standard-specific domains such as shipevermore.dev. Clear branding, but extra permanence/migration obligations and unverified availability.

Skeptic: Initial filing-stage objection, not an independent pass: Deferral can leak relative ids into a release. Require ownership, trademark evidence and an absolute-id migration as publication gates; privacy alone is not a namespace plan.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

Private drafting can continue; public release waits for the namespace ruling and #186 evidence.

Operator answers: “D11 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Check current domain/mark availability and ownership; compare URI permanence and bring a concrete recommendation with migration examples.
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
