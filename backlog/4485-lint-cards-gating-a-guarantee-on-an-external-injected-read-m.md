---
bornAs: x60c5ua
kind: task
parent: "4075"
status: open

dateOpened: "2026-09-29"
tags: []
---

# Lint: cards gating a guarantee on an external/injected read must enumerate all its outcomes

Follow-up from we:backlog/4314-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md, guard 1 (prevention owed by chalbert/web-everything#2831's independent review): "A fold-in checklist/lint rule requiring that any decision/story card gating a guarantee on an external or injected read (here, a listing helper) enumerate ALL of that read's documented outcomes (success/empty/error) in its ownership table and Test plan, not just the outcomes relevant to the motivating scenario."

## Design gist
Add a new rendered-body lint check alongside the existing ones in we:scripts/check-standards-rules.mjs#lintBacklogItemRendering (near findBuriedForkSections/findBadBodyLinks) that flags a decision/story card whose body: (a) names an external or injected read as the basis for a guarantee (an Ownership table, a claim of the shape "X only ever ...", a cited helper/listing function), and (b) enumerates fewer outcome branches in its own Ownership table / Test plan than the read itself is documented to have (success/empty/error, or whatever the cited functions own doc comment lists). The detector should be conservative: it flags only cards that already have BOTH an Ownership-shaped table AND a cited external/injected read, never a bare heuristic scan for keywords alone, to avoid false positives on ordinary cards.

## Edge cases the check must handle
- A card with no Ownership table and no cited read at all: never flagged (out of scope for this check).
- A card whose Ownership table already enumerates every documented outcome, in any order or wording: not flagged.
- A cited read whose own doc comment lists exactly one outcome (nothing to omit): not flagged.
- A card citing a read this checker cannot resolve (unknown file, no locus prefix): treated as unknown, not flagged (never a hard failure on an unresolvable citation).
- A card that intentionally scopes down to a subset of outcomes and says so explicitly (e.g. "the empty case is out of scope, see follow-up #NNN"): not flagged — an explicit scope-narrowing note is a documented decision, not a gap.

## Test plan
Add unit tests to we:scripts/__tests__/check-standards-rules-content-lint.test.mjs covering the positive case (a card omitting the empty-outcome branch is flagged) and every edge case above. Also add ONE integration/wiring test that runs the real check:standards content-lint pass over a fixture backlog item (not just the isolated pure function) to prove the new check is actually wired into the pass that gates a land, not just unit-tested in isolation.

## Why filed, not built here
we:backlog/4314-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md's own MVP built a different guard (finding 4, an example-based regression test + fix in we:scripts/operations/completion-store.mjs); this finding needed its own design pass (the outcome-enumeration heuristic above) that would have grown 4314 past a single-responsibility change, so it is filed here per this repo's small-file/single-responsibility preference. Its own `Done when` is left as the standard un-prepared placeholder on purpose — like every mechanically-filed card, it gets its own PREPARE pass (Design/MVP/Test plan/Done-when) when a delivery agent picks it up, the same discipline this item's own build followed.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Findings (standalone worker, 2026-11-02)

The build-dispatch daemon held #4485 with:

> worker-declined: Not prepared: #4485 — could-not-prepare. The unresolved choice is whether outcome coverage uses a structured authoring contract or best-effort prose inference. The card promises recognition “in any … wording,” including arbitrary documented outcomes, but defines no matching contract. Choosing structured annotations would change authoring policy; choosing heuristics would narrow that guarantee. The current lint interface also lacks source-reading support ('we:scripts/check-standards-rules.mjs:1385'); both production callers would need consideration ('we:scripts/check-standards.mjs:982', 'we:scrip…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
