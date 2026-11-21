---
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407"]
---

# Build on existing event, attestation and findings norms?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D7 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Adopt existing norms in distinct layers: CloudEvents/CDEvents for events, in-toto for attestations, SARIF for findings, and OpenTelemetry/DORA as mappings. Ship adds only its delivery-specific delta.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() “Norms” adopts CloudEvents 1.0, in-toto Attestation v1, SARIF 2.1.0, BCP 14, JSON Schema 2020-12, SemVer and RFC 8126. OTel semantic conventions and DORA are bindings, not core field names; AsyncAPI waits for a live channel.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Supported by default

**Support all listed norms in their own layers (default).** CloudEvents + CDEvents carry events; Ship adds claim, handoff, verdict and lever. in-toto carries verdict/run evidence; SARIF carries findings; OTel/DORA are mapped views.

Why no fork: These formats address separate layers and can coexist.

Skeptic: Initial filing-stage objection, not an independent pass: Layering norms can add wrappers without interoperability. Require concrete mappings and round trips; do not rename core fields to OTel/DORA vocabulary.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

A small delivery vocabulary with interoperable envelopes, evidence and findings.

Operator answers: “D7 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Check upstream versions/licences and map the four missing delivery concepts with lossless examples.
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
