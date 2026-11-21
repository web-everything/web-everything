---
kind: story
size: 3
parent: "5488"
status: open
blockedBy: ["5407"]
dateOpened: "2026-11-21"
tags: []
---

# Run hybrid step 5 kernel ci-heal in shadow against Ship drafts

Implement the hybrid kernel ci-heal shadow slice only after Ship Work Item, Claim and Verdict drafts exist, with tapped-event equivalence and no forge writes.

## Design

Hybrid **step 5: kernel ci-heal in shadow**, under #5488/D1. Source: `longshore-end-state-2026-11-20` §4 step 5 and D1-5488 in the Standards decisions-prep set. Placement: Longshore implementation; WE only holds this tracking card pending extraction.

This is distinct from the old Slices table's #5494/#5495 mirror-based pass/build/drain shadow work. It emits Ship-observable claims and verdicts, so **blockedBy #5407** requires the Work Item, Claim and Verdict drafts before implementation. #5407 exists as the Delivery-standard protocol epic. Add finer draft edges when those cards exist; do not substitute Longshore-owned normative shapes. #5488's D1/D2 proposals must also be ratified before work starts.

## Acceptance

- [A1] Pin Ship Work Item/Claim/Verdict draft versions and content hashes; no production-shaped local substitute. Record the draft evidence when unblocking.
- [A2] Shadow harness compares tapped legacy and kernel ci-heal actions for 24 h at zero unexplained diffs, declaring intended differences in advance. Missing/unmatched decisions are diffs; a tap-off window is invalid.
- [A3] Run replay and crash/unknown-input cases, record the runnable Longshore harness command and pinned results before claiming readiness. Shadow has no forge-write credentials; this card does not authorize a role flip.

## Non-goals

Public release, drain migration, any live authority switch or defining Ship contracts inside Longshore.

## Trust boundary and threat model

Tap events and forge payloads are untrusted. Freeze the soak/replay input set, bind outcomes to heads and sequences, and prevent shadow effects. Missing drafts or incomplete evidence block readiness; escalate to the draft owner rather than weakening the comparison.

Source and proposed artifact filenames (handoff references are by name only):

```text
D1-5488.md
longshore-end-state-2026-11-20.md
```
