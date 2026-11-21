---
bornAs: xcwzfo3
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407"]
preparedDate: "2026-11-20"
---

# What does Ship 0.1 cover: metrics shapes or protocols too?

Ask: Candidate labels cover only modules with vectors and a passing live implementation. Readout is the first target; plans and protocols stay Draft until proved.

## Digest

**No independent fork if #8623 adopts per-module maturity.** Release content and authoring order compose. Candidate is the promise, not a pre-1.0 compatibility guarantee. Prep at 2026-11-20 found no live readout consumer yet, so even readout is conditional.

## Ratify — Candidate coverage

**0.1 promises only modules with vectors passing on at least one live implementation.** Readout L1 is the first target when Plateau /delivery or another producer consumes live data and passes. Other modules may share a tag as Draft, or remain absent.

- Excluded: all seven seed shapes as Candidate; six lack an engine implementation.
- Excluded: Candidate protocols before ratified flow core and implementation proof (#8633/#5407).
- Fallback if #8623 rejects per-module maturity: the release-wide scope fork returns. **(a) metrics shapes only, protocols 0.2+ (default)** versus (b) shapes + protocols; (b) lacks flow/implementation proof. Retain the live-consumer freeze. This is conditional, not a second current call.

Evidence:
- `everstandards-format-2026-11-20`: capacity/planning/readout; L1 readout-producer, L2 planner, L3 placer. Seed `652fb00409` has settings/calibration/plan/readout/levers/forecast/promises.
- Prep checked plateau-app `af64fef` and found no readout route/consumer; Longshore had no kernel (`longshore-end-state-2026-11-20`). Historical snapshot, not current proof.
- `2026-11-20-flow-core-model` §14, `2026-11-20-flow-agent-orchestration` F4-D3/D6 leave protocol lifecycle/handoff details open.

Skeptic: SURVIVES-WITH-AMENDMENT; defined promise as module Candidate. Screen: flagged(prio) → dissolved into #8623's evidence rule.

## Supported by default

- Draft modules may appear in the same tag with migration notes/no compatibility promise. First conforming L1 producer counts, regardless of vendor.
- #8633's core → protocols → metrics authoring order does not prevent readout becoming Candidate first.
- Before freeze, fix band-name collision, optional DORA block and evidence envelope through separate work (`we:2026-11-20-ship-delivery-metrics.md:246/:264-271`).

## What ratifying unlocks

Bounded 0.1 target: Plateau /delivery live-readout/L1-vector follow-up, then evidence-based graduation of other shapes. “D13 yes” confirms the consequence; Ship freeze still requires operator go.

## Trust boundary and threat model

Seed README claims do not prove conformance. Use pinned implementation SHAs/results for each module; no date-based freeze or unsupported Candidate label.

Full prep (Standards decisions-prep set):

```text
D13-xcwzfo3.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-flow-agent-orchestration.md
2026-11-20-flow-core-model.md
D13-xcwzfo3.md
everstandards-format-2026-11-20.md
longshore-end-state-2026-11-20.md
```
