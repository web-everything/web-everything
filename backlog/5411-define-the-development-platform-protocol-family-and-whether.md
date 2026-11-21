---
bornAs: xyek4mq
kind: decision
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
tags: []
relatedTo: ["5409", "8623"]
preparedDate: "2026-11-20"
---

# Define the development-platform protocol family and whether it shares the delivery protocol home

Ask: Keep Platform Forever as preferences for now. Ship only schema/defaults in Longshore; teams own their values. Draft each module when research proves its interoperability delta, and graduate only on independent conformance evidence.

## Digest

**Validation gate, verdict not-yet**, plus one forced values boundary. The open merit question is whether each module adds requirements absent from incumbents, pending P1–P4 research. A second team's demand gates Stable, not drafting. This replaces the earlier “preference file inside Longshore until second team” update.

## What you're deciding

Candidate modules: workspace-manifest, workspace-lease, dev-server-discovery, gate-contract, platform-graph and dev-tooling-attach. Preference-first and later standardization are stages, not rival designs.

## Recommendation — concrete per-module triggers

- **Not-yet (default). Draft trigger:** P1–P4 identify a named requirement Dev Container/BiDi/CDP/MCP/Backstage/Score cannot express.
- **Stable/1.0 trigger:** a second team in another org uses it in real work, both implementations pass the shared suite, and schema remains unchanged for a release cycle. Apply per module; no family-wide wait.
- Publishing now has no demonstrated delta; private config forever discards portability. Neither is a competing permanent design to ratify here.

## Context and prior-art delta

- Dev Container began as product config, later a spec; customizations keep team/tool values separate. [Supporting implementations](https://containers.dev/supporting) show existing adoption.
- [BiDi](https://www.w3.org/TR/webdriver-bidi/), CDP and MCP already cover attach; bind them rather than invent replacements. Backstage reserves core-key prefixes; Score/OAM warn against declaring a spec without an independent process (`2026-11-20-pf-standard-vs-preference`; OAM announcement date unverified).
- [TC39 Stage 4](https://tc39.es/process-document/) grounds independent passing implementations for Stable, not a draft gate. [CNCF platforms](https://tag-app-delivery.cncf.io/whitepapers/platforms/) favours the thinnest consistency layer.
- Proposed delta: portable values across all six concerns rather than replacing each incumbent. #5600/end-state §1.1 already supplies the cascade design.

## Ratify — values stay with the team

**Longshore ships preference schema and defaults only.** Values belong in team repo/org configuration or operator live settings. Excluded: committing one team's values to the product; violates settings.operatorOutOfProduct (21:38).

## Supported by default

- Reserved core prefix plus customizations-style extension object; future promotion only moves reserved keys. Namespace #8626.
- Bind incumbent formats; shared template #8623, licence #5403 and governance #5409 apply on graduation. No new repo before the first module earns a draft.
- P1–P4 research still runs before spec text. End-state family ambition remains; this gate changes readiness, not the ambition.

Skeptic: SURVIVES-WITH-AMENDMENT (`_skeptic-governance-group`); moved second-team proof to Stable and grounded not-yet in unresolved merit delta. Screen: flagged(prio) → rewritten/clear. Values boundary survives.

## What ratifying unlocks

Bounded preference schema/defaults, team-owned values and checkable promotion triggers per module. “D15 yes” confirms; no new standard repo today.

## Trust boundary and threat model

Research/third-party descriptions are evidence, not proof of interop. Do not promote team values into normative fields; freeze requirements and suite results at each graduation.

Additional primary evidence: [source 1](https://github.com/oam-dev/spec).

Full prep (Standards decisions-prep set):

```text
D15-5411.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-pf-standard-vs-preference.md
D15-5411.md
_skeptic-governance-group.md
```
