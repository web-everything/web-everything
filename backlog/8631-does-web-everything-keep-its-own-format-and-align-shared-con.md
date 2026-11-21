---
bornAs: xjeammk
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, web-standards]
relatedTo: ["5407"]
---

# Does Web Everything keep its own format and align shared conventions?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D9 (decisions page, 2026-11-20 20:58 ET)
Placement: stays in WE

## Digest

Keep WE’s format and align shared conventions: MUST/SHOULD wording, vector/manifest shapes and maturity mapping. The page inventories 60 plugs, 81 blocks and 100 intents already checked by WE tooling.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() “How WE writes standards today” and “Template detail” retain JSON + njk, EARS and typed contracts. Proposed mapping: concept≈pre-Draft, draft≈Draft, experimental≈Candidate, active≈Stable (R942 corrected).

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Supported by default

**Keep and align (default).** Retain WE authoring, share BCP 14 wording/vector shape and publish a maturity mapping.

Why no fork: Two formats can share conventions without wholesale migration.

Skeptic: Initial filing-stage objection, not an independent pass: Alignment may be superficial while L0–L2 and L1–L3 differ. Publish and test a mapping; do not silently equate different level names or treat unverified active status as two independent implementations.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

Interoperability without migrating WE’s definitions; shared conformance work proceeds under D17.

Operator answers: “D9 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Inventory vector/manifest differences and validate level/maturity translations against actual evidence.
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
