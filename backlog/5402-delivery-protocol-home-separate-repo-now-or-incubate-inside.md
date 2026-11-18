---
bornAs: x4ek3hr
kind: decision
size: 2
parent: "5407"
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-11-17"
preparedAgainstSha: "7491c6ecda714ea2590065f2a2e3c166b306d9bc"
relatedReport: reports/2026-11-17-delivery-protocol-home.md
tags: []
---

# Delivery protocol home: separate repo now, or incubate inside Web Everything

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Open decisions' item 1 and 'Proposed structure'. Fork: (a) a new repo now that holds only the standard (schemas, role registry, policy dimensions, glossary, conformance cases), with the engine staying where it runs until extraction; (b) incubate the standard inside Web Everything first. Incubating is faster, but WE's own history shows implementation leaking into a standard repo becomes relocation debt, and the scope is not web (#1282 zero-implementation rule). Brief's recommendation: (a). Operator's call; not ruled here. Research: [we:reports/2026-11-17-delivery-protocol-home.md](/reports/2026-11-17-delivery-protocol-home/).

## Known occurrences

Comparable standards each have their own spec home with implementations downstream: OpenTelemetry (spec repo apart from SDKs), in-toto/SLSA (spec repos), MCP (spec plus schema repo, SDKs separate), SARIF (schema apart from tools). In WE itself, implementation that landed in the standard repo became tracked relocation debt (#1078 subsystems, #1294 cascade, #2006 website) per `we:docs/agent/platform-decisions.md#constellation-placement`.

## Supported by default

- The engine/kernel stays where it runs until extraction; neither fork moves it (its home is the separate, still-open #2446).
- Policy dimensions (#4376 / #4305) and the run record envelope (#5348) are authored in whichever home this picks; they are not re-decided here.

## Fork 1 — Home of the delivery standard

Fork-existence: the branches cannot coexist as the live source of truth, since two homes for one schema set would drift. The real collision is `we:docs/agent/platform-decisions.md#constellation-placement` rule 1, which homes "code that defines a contract (types, protocol, conformance vectors)" in WE and knows only three homes (WE, FUI, Plateau). The delivery protocol is contract-tier content but is not a web standard, so ruling (a) must amend that anchor; ruling (b) needs no amendment but puts a non-web standard under WE's web identity. (#1282 is cited only for zero-implementation, not for web scope; #2446 is still open and is not precedent.)

- (a) **New repo now, standard only** (schemas, role registry, policy dimensions, glossary, conformance cases, verifier-as-data). Engine stays put.
- (b) Incubate inside WE first, extract later.

**Default: (a).** Ratifying (a) carries an explicit amendment to `#constellation-placement`: "contract-tier content for a non-web standard homes in its own standard repo, not WE." Merit: a non-web standard under WE's web identity is mislabeled for adopters, and a later extraction rewrites history and links; starting separate costs a second repo's CI, release and backlog (real for a single operator, not "one empty repo"). Lock-in is low either way because standard-only content moves cheaply. Extraction trigger if (b) is chosen instead: split when a second implementer appears. Layout sketch for (a):

```text
delivery-standard/
  schemas/work-item.schema.json   # JSON Schema, single source
  roles/registry.json
  policy/dimensions.json
  conformance/cases/*.json        # vectors only, no engine
  GLOSSARY.md
```

Rejected: (b) is faster for the first week only; its reason ("WE has the lint and conformance tooling") is consumable across the seam as data, as FUI does.

Skeptic: SURVIVES-WITH-AMENDMENT. (a) holds, but it collides with #constellation-placement rule 1 (contract content homes in WE), so ratifying (a) must amend that anchor; dropped the #2446-as-precedent and #1282-as-web-scope claims (over-read), added the second-implementer extraction trigger and the honest second-repo cost.
Screen: clear

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; if (a), a follow-up card creates the repo.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
