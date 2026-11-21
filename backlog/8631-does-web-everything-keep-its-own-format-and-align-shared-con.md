---
bornAs: xjeammk
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, web-standards]
relatedTo: ["5407"]
preparedDate: "2026-11-20"
---

# Does Web Everything keep its own format and align shared conventions?

Ask: Keep WE's source format and export the shared shapes. Compute maturity from evidence; active alone proves neither Candidate nor Stable.

## Digest

**No real fork: keep plus export compose.** D6/#8623 fixes interchange, not authoring. Prep found two forced corrections: evidence-derived maturity and two distinct conformance-level families. Counts below are the 2026-11-20 snapshot at cd0e13d14c.

## Ratify 1 — evidence-derived maturity

**WE status is an upper bound, never proof of an exported stage.**

| WE status | Maximum export, subject to evidence |
|---|---|
| concept | pre-Draft |
| draft | Draft |
| experimental | Draft |
| active without implementation evidence | Draft |
| active with vectors and one passing implementation | Candidate |
| any claimed Stable | two independent pinned-suite passes under #8623 |

Excluded: automatic experimental≈Candidate/active≈Stable. Of 76 active entries only 36 name implementedBy, all blocks; the field holds one string. Active plugs 31, blocks 39, intents 6, protocols 0. Registry evidence must supply independent passes.

Evidence: `we:docs/agent/block-standard.md:104-114`; prep locates the implementedBy check at `we:scripts/check-standards.mjs:440-441`, a warning for blocks only, not the stale :155 reference. WE's protocol second-implementation rule is a minting rule, not a maturity badge.

Skeptic: SURVIVES-WITH-AMENDMENT; corrected false “active requires implementation” and stale locator. Screen: clear.

## Ratify 2 — no silent level equation

**Two axes need two mapping tables:** manifest L0–L2 (`we:capability-manifest/provider.ts:31`) → product/profile levels; webcases L1–L3 (`we:webcases/requirementValidator.ts:25`) → per-outcome vector level. Proof vectors check each row. Excluded: same-name L1=L1 equations or one merged scale. Any internal vocabulary reconciliation is separate WE work.

Skeptic: SURVIVES-WITH-AMENDMENT; two distinct axes, not alternative names for one scale. Screen: clear.

## Supported by default

- WE JSON/njk/EARS remains source; export #8623 ids, traceability, vector, profile and maturity shapes. Migration may happen later but is unnecessary across the boundary. `we:webcases/caseToVector.ts:96` is an existing export precedent.
- EARS and BCP 14 coexist. Publish a lossy-field table for vector exports.
- Traceability export is new work: per-statement [@test] appears once in src in this snapshot; unmapped MUSTs stay visible and ratchet down.
- Runner custody is #8627, including reconciling existing placement rulings.

Evidence: `everstandards-format-2026-11-20`; `2026-11-20-es-standard-models` (webref/WPT export precedent).

## Must-hold rules from the threat-model red team

- Missing evidence exports **no stage**, never a default stage. The table gives ceilings only.

Details: `_redteam-format-group`.

## What ratifying unlocks

WE export/binding work, separate maturity and level mappings with proof vectors, and stale-reference cleanup. Follow-ups: #8637 (maturity) and #8636 (level axes/stale reference). No WE definitions migrate. “D9 yes” confirms.

## Trust boundary and threat model

Generate claims from source and pinned results; hand-edited/stale mappings must fail proof vectors. Never trust status strings as conformance evidence.

Full prep (Standards decisions-prep set):

```text
D9-xjeammk.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-standard-models.md
D9-xjeammk.md
_redteam-format-group.md
everstandards-format-2026-11-20.md
```
