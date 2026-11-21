---
kind: story
size: 2
parent: "8631"
status: open
dateOpened: "2026-11-21"
tags: []
---

# Reconcile WE conformance level scales and stale maturity references

Document separate readout, product and assertion level axes, distinguish them from maturity, and repair the stale implementation-evidence reference in the format design.

## Design

Placement: WE. Source: `everstandards-format-2026-11-20` (handoff designs), “How WE writes standards today”, “Ship modules” and the stale :155 citation identified in D9-xjeammk.

Explain in plain words that **L1 readout / L2 planner / L3 placer describe product capabilities**, while Draft/Candidate/Stable describe maturity evidence. They are separate axes. Also reconcile WE's capability-manifest **L0–L2** (`we:capability-manifest/provider.ts:31`) with webcases assertion tiers **L1–L3** (`we:webcases/requirementValidator.ts:25`): D9 maps the former to profile levels and the latter to vector levels, not one merged table.

Repair the stale implementation-evidence reference: :155 is not a reliable locator for a rule that active means implemented. Prep instead located a **blocks-only warning** at `we:scripts/check-standards.mjs:440-441`; active entries outside blocks need not name an implementation, and one implementedBy string cannot prove two independent implementations. Check the current rule and link its actual owner rather than copying old line numbers. The present handoff design is shorter than 155 lines; the stale locator is cited by the prep, not a current line 155 in that file.

## Acceptance

- [A1] Documentation review shows separate named tables for readout/product levels, WE manifest levels, webcases outcome tiers and maturity, with no implicit L1=L1 or active=Stable equation.
- [A2] Each mapping row identifies its evidence/proof vector; any vocabulary merge is explicitly proposed rather than silently assumed.
- [A3] Verify the active/implementedBy rule in the current tree, correct the stale citation and describe warning scope accurately. Changes to the read-only design belong to a separately authorized follow-up, not this filing.

## Non-goals

Changing standard requirements, silently renumbering conformance levels or counting status strings as implementation proof.

## Trust boundary and threat model

Historical line references are leads, not proof. Pin the inspected revision; a missing rule or evidence leaves the mapping unproven rather than guessed.

Source and proposed artifact filenames (handoff references are by name only):

```text
D9-xjeammk.md
everstandards-format-2026-11-20.md
```
