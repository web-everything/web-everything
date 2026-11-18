---
bornAs: xff6baf
kind: decision
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-11-17"
preparedAgainstSha: "157f3184592f9b20aa4356a18cfd34df7f86a099"
relatedReport: reports/2026-11-17-delivery-standards-rehome.md
tags: []
---

# Re-home delivery standards to the new initiative, superseding the #4376 and #690 placement rulings

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Open decisions' item 2. Today #4376 puts the delivery policy schema in Web Everything, and #690 (resolved) ruled the tool-agnostic methodology protocol (#672) has no owning project. A separate delivery standard home contradicts both. Brief's recommendation: one decision that re-homes delivery standards (policy dimensions, methodology protocol, the work-item contract in we:contracts/backlog.ts, the review-policy contract) to the new initiative, and leaves #2446 to decide the product's home. Must name which statute anchors in we:docs/agent/platform-decisions.md change. Operator's call; not ruled here. Research: [we:reports/2026-11-17-delivery-standards-rehome.md](/reports/2026-11-17-delivery-standards-rehome/). Depends on #5402 (a new home must exist); independent of #5405 (naming).

## Known occurrences

Spec homes separate from consumers: OpenTelemetry, in-toto/SLSA, MCP, SARIF. In this tree: #4376 names WE as the standard's home; #690 (ratified 2026-06-15) did not rule "no owning project" as the brief says, it ruled a first-class WE node (`webprocess`, owning the `self-driven-project-artefact-contract` protocol) and "lives in WE, scoped to web apps initially, schema kept domain-general". `we:contracts/backlog.ts` is the provider-agnostic backlog interlingua from #2558, imported by the Plateau console, so it is not delivery-specific.

## Supported by default

- Which repo hosts the standard is #5402's call; this card only says what moves into it. If #5402 rules (b) (incubate in WE), nothing moves and this card closes as moot.
- The engine and its home stay with #2446; policy dimension content stays #4376 / #4305; naming stays #5405.

## Fork 1 — What re-homes, and which statute anchors change

Fork-existence: the branches cannot coexist as the live source of truth (two homes for the same schema would drift). The real collisions are `we:docs/agent/platform-decisions.md#constellation-placement` rule 1 (contract content homes in WE), the #690 ruling (methodology protocol owned by a WE node), and `#protocol-host-project` (a WE Protocol requires a WE owning project). Moot if #5402 rules (b).

- (a) Move everything the brief lists: policy dimensions, methodology protocol, work-item contract, review-policy contract.
- (c) **Move the delivery-specific standards (policy dimensions, methodology protocol, review-policy contract); keep `we:contracts/backlog.ts` in WE** as the type-only provider interlingua, with the new repo's work-item schema mapping onto it.

**Default: (c).** Applies only if #5402 rules (a). Ratifying (c) amends three anchors: `#constellation-placement` (the same single amendment as #5402, applied once), the #690 ruling (Axis 1 owner moves out of WE; the `webprocess` node is retired or repointed; #690's own "schema kept domain-general" clause is the stated trigger), and `#protocol-host-project` (the `self-driven-project-artefact-contract` entry leaves WE `protocols/*.json`, or becomes a pointer, since a WE Protocol needs a WE owner). #4376's "WE = standard" line is also superseded. Merit: moves exactly what is delivery-specific and non-web, and avoids breaking the `@webeverything/contracts/backlog` import path for a contract that serves Jira/Linear/GitHub as much as delivery. The review-policy contract has no file today, so it is authored in the new home with no move.

Rejected: (a) drags a cross-provider contract out from under its current consumer and rewrites an import path for no standards gain. "Move nothing and revisit at extraction" is not a branch here: it is #5402's (b) (no new home) or a timing question, so it is recorded under Supported by default, not as a fork option.

Also named so no reader over-reads (c): `#monetization` is #690's `codifiedIn` anchor and its lineage line is amended (the methodology's owner moves); `#backlog-tracking-locus-now-distributed-next` (#3129) covers the backlog tracker, not contract code, and is untouched. The `webprocess` node is **repointed** to the new home as a pointer, not deleted, until #5405 names the delivery layer. #5401 (kind-list reconcile) consumes the mapping onto `we:contracts/backlog.ts` and must not assume the file moves. #5402 should cross-reference this card for the `#690` and `#protocol-host-project` amendments.

Skeptic: SURVIVES-WITH-AMENDMENT. (c) holds and its facts check out (#690 ruled a WE node, not "no owner"; `we:contracts/backlog.ts` is the cross-provider interlingua). Added the missed `#monetization` codifiedIn anchor, an explicit `webprocess` repoint choice, #5401 as consumer of the mapping, the out-of-scope #3129 tracker anchor, and a #5402 cross-reference.
Screen: flagged(prio) → dropped the "move nothing, revisit at extraction" branch (sequencing, and moot under #5402 (b)); fork is now (a) vs (c); no impl flag.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; codifiedIn names the changed statute anchors.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
