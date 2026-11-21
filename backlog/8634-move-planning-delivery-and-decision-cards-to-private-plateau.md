---
bornAs: xx623wo
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5500", "5497", "5486", "5488", "3533"]
preparedDate: "2026-11-20"
---

# Move planning, delivery and decision cards to private plateau-app: scope, mechanics and when?

Ask: Route private/business cards to plateau-app, engine cards with Longshore code, standards to everstandards and web standards to WE. Confirm whether the 21:00 instruction instead meant all engine cards should be private in Plateau.

## Digest

Prepared, not ratified. One real fork survives: authoritative card home. Writer/identity become invariants; timing becomes dependency ordering. No cards have moved. Prep found plateau-app without a backlog/tooling, Longshore private and Ship private/frozen. Home, execution locus and mechanics are separate axes.

## Fork 1 — Which cards go where

Either/or: one authoritative file owns a card. A Plateau card with Longshore locus is possible, so composition does not settle custody.

- (a) **Topic plus sensitivity (default):** sensitive/Plateau-touching product, pricing, business/private ops → private plateau-app; engine/daemon/conveyor/drain/lane/backlog-tooling → Longshore; non-Plateau standards → everstandards; web standards → WE; FUI → frontierui. Unknown classification stays private pending a person. Decisions follow topic.
- (b) All delivery/planning/decision cards → plateau-app: coherent privacy and one target, and plausible reading of 21:00 backlog.movePrivateToPlateau/R941d. But conflicts with repo-owned backlog statute, R160 and #5488 S7, leaving public Longshore without its own backlog. Tonight's words did not mention Longshore, so this ambiguity needs the operator; do not claim (b) already superseded.
- (c) Strict topic routing including sensitive cards to future-public Longshore. *Excluded:* violates R943 privacy rule.

Evidence:
- `we:docs/agent/platform-decisions.md#backlog-tracking-locus-now-distributed-next`: repo and backlog move together; ids/locus/aliases.
- `backlog-split` §2 and review corrections; `we:rulings.md:2229` R943; operator-settings backlog.placementRule/backlog.movePrivateToPlateau; #5500/#5486/#3533/#5497.
- Historical 11-15 classifier: 8,035 cards, 5,319 private-ops, 333 Plateau, 57 web standards, 1,725 unclassified and 137 ambiguous. Re-run before batches. Engine cards are already public in WE; re-review sensitivity before #5499 publication.

Skeptic: SURVIVES-WITH-AMENDMENT; acknowledged the live ambiguity in (b), grounded (a) in statute/R160/S7 rather than tonight's wording. Screen: clear.

## Ratify — identity, writer and dependency invariants

- **R1 Locus-bearing ids, permanent formerly aliases and WE redirects**, resolved cards included (#3533/#5486/S7); one-release-only forwarding is excluded.
- **R2 Destination repo numbers its own cards.** This is an inference from repo autonomy, not literal statute wording. Exclude global cross-repo allocator; retain WE allocator during transition and preserve bornAs for ledger joins.
- **R3 Store/writer live in @longshore/backlog**, never new WE delivery runtime.
- **R4 Moving does not unpublish git history.** No rewrite unless secrets leak (R972); retain public-history privacy review.
- **R5 Split #5500 dependency paths:** Plateau-bound cards need #3533 → #5486, store-aware readers (backlog/readiness/dispatch-plan/docket) and privacy classification, not engine flip #5497 or code move #5484. Longshore batches retain #5497 plus locus registration (#6911 closed unmerged in prep). Ship batches wait unfreeze (#8624). Moving before tooling is excluded: prep found 149 readers hard-coding backlog/, so cards disappear from queues and links break.

These amend the statute's interim “no second backlog/numbering authority” clause at ratification; no migration is authorized by merely landing this prep.

## Supported by default

- Card-only PR is public-store default. Direct writer push is a per-store option requiring its own App bypass/security card; D18 grants no bypass. Required protections include card-only paths, lint, secret scan and idempotent retries.
- Optional combined Plateau index; sensitive new filings move private once store/readers exist.
- Classifier: explicit locus/scope → ownership/topic → parent inheritance → private fallback. Use we:config/constellation-ownership.json, not raw scripts paths/tags.

## What ratifying unlocks

Re-slice #5500 by destination, store-aware writer/classifier work and a private-filing slice. “D18 yes” accepts topic/sensitivity routing and explicit transition statute amendment; ambiguous cards still need classification.

## Trust boundary and threat model

Card text/cross-store refs/writers are untrusted. Snapshot each classified batch with before/after counts, never a live glob. Public site renders only public stores; private paths never enter forge bundles. History rewriting is outside scope.

Full prep (Standards decisions-prep set):

```text
D18-xx623wo.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
D18-xx623wo.md
backlog-split.md
```
