---
bornAs: x5ef2ux
kind: story
size: 3
parent: "2705"
status: open
blockedBy: ["2998"]
locus: plateau-app
scope: ["plateau-app:src/backlog-view/"]
scopeRationale: "Filed sight-unseen from web-everything (never opened plateau-app:src/backlog-view/'s ~40 files) — the exact file(s) the featureOf derivation lands in are for the builder to narrow on pickup."
dateOpened: "2026-08-15"
preparedDate: "2026-10-02"
preparedAgainstSha: "09a680ad8c8fd2cffd25cf8a8437a2c33d30d1e1"
tags: [taxonomy, data-model, hierarchy]
---

# Wire the featureOf rollup consumer in Plateau's backlog view

Group epics under their nearest explicit `kind: feature` ancestor through `parent`, with feature-less epics in **Unassigned**. The binding rule is [we:docs/agent/backlog-workflow.md#feature-tier](../docs/agent/backlog-workflow.md#feature-tier), lines 186–197. This is a consumer implementation of that rule, not a new hierarchy or an authored grouping field.

Path notation: sibling source citations below use `we:../plateau-app/` relative to the canonical WE checkout; preparation inspected the operator-specified Plateau checkout, not a lane-relative sibling. The existing machine-readable Plateau scope prefix is retained for correct dispatch.

## Progress

Preparation inspected WE HEAD `09a680ad8c8fd2cffd25cf8a8437a2c33d30d1e1` and Plateau HEAD `56f3f6efadb6c4d016f9fd8fb349f1be4430e949` (no tracked Plateau modifications).

- **Old premise:** #2998 had landed and only an existing epic-rollup consumer needed wiring. **Correction:** current WE has the feature vocabulary and grouping-kind helper (we:scripts/check-standards-rules.mjs:234,253), feature tier/sliceability handling (we:src/_data/backlog.js:221–240), and invariant validation (we:scripts/check-standards-rules.mjs:472 onward). However, #2998 still says `status: open` and declares both repos (we:backlog/2998-implement-the-feature-tier-kind-feature-above-epic-with-epic.md:6–21). This preparation does not assert that the entire prerequisite is delivered or remove its dependency.
- **Old premise:** general backlog/lane-board surfaces already consume epic rollups. **Correction:** the list supports only none/status/area grouping (we:../plateau-app/src/backlog-view/backlog-view.ts:298,459–475); the lane board groups in-flight work by owner/session/lane (we:../plateau-app/src/backlog-view/lane-board-data.ts:225–296). Add a feature grouping choice to the general backlog list; do not replace lane ownership grouping.
- **Confirmed data seam:** the parser reads `kind` and normalizes `parent` references (we:../plateau-app/src/backlog-view/parse.ts:142–150,193–200); the loader calls that parser and emits list fields (we:../plateau-app/src/backlog-view/loader.ts:67–85). Types extend the WE contract (we:../plateau-app/src/backlog-view/types.ts:27–45), whose `kind` and `parent` already exist (we:contracts/backlog.ts:47–54). No new wire field is needed.
- **Old scope:** the whole backlog-view directory, explicitly filed sight-unseen in the preserved `scopeRationale`. **Prepared scope:** the concrete source and test files below. That frontmatter rationale is historical; this body supersedes its uncertainty without changing unrelated metadata.

## Design

1. Add a pure `featureOf` derivation in the existing list module. Start at an epic's parent; resolve references with the same num/id lookup convention as existing relationships (we:../plateau-app/src/backlog-view/backlog-view.ts:540–550). Return the first explicit feature node. Missing parent, missing target, or a repeated identity returns null. Seed the visited set with the starting epic; terminate on self-links and longer cycles. Do not infer a feature from a root epic or follow `blockedBy`.
2. Build the ancestor lookup from the **full loaded response**, not the filtered rows. The list already indexes the full response for blockers (we:../plateau-app/src/backlog-view/backlog-view.ts:205–209), but currently calls grouping with only displayed items (same file:220–222). Pass full graph context into the grouping derivation so hiding a feature or intermediate ancestor cannot reassign an epic.
3. Extend the existing group selector and arrangement description with a feature option (we:../plateau-app/src/backlog-view/backlog-view.ts:479–504). Partition visible epics by feature identity, not title; label sections with feature number and title. Sort feature sections deterministically by identity, retain the selected row sort inside sections, and put Unassigned last among epic sections. Emit Unassigned only when it has members. Keep visible non-epic rows in a separate **Other items** section so choosing this arrangement does not silently discard stories, decisions or feature cards. Preserve the existing unreadable section and total counts (same file:217–228).
4. Reuse the existing section renderer, escaped labels, row selection and detail behavior (we:../plateau-app/src/backlog-view/backlog-view.ts:178–185,220–228). This change adds no independent interaction mechanism, authored field, status/progress calculation, or feature-tracker baseline acceptance.

## Scope

Keep the existing Plateau-only directory scope as the dispatch envelope; its concrete implementation touch-set, **including tests**, is:

- we:../plateau-app/src/backlog-view/backlog-view.ts — derivation, grouping, selector and rendering integration.
- we:../plateau-app/src/backlog-view/backlog-view.test.ts — pure derivation and rendered grouping cases; existing group/list coverage is at lines 438–499.
- we:../plateau-app/src/backlog-view/mount.test.ts — selector, filtering, refresh and reset integration; existing arrangement tests are at lines 280–344.

Read-only dependencies include the parser, loader and shared contract cited above. No WE implementation or contract edit is necessary for this consumer. No lane-board or feature-tracker edit is included.

**Per-repo delivery (#4289):** the ruling chose a WE contract predecessor and Plateau successor for its mixed-scope case, while retaining coupled delivery as future capability (we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:20–22). Apply that seam here: existing WE prerequisite #2998 owns vocabulary/invariants; this card owns the Plateau consumer and its tests, under the preserved `blockedBy`. Do not dispatch #2998's stale mixed scope as part of this card. If implementation discovers a necessary contract change, propose a separately validated WE predecessor and update dependencies through a separate authorized card edit before dispatch. Single-backlog ownership and per-repo gates follow we:docs/agent/platform-decisions.md:5511–5529 (`#conveyor-multi-repo-model`).

## MVP

Ship one feature grouping choice in the existing backlog list. Direct and deep epic ancestry resolve to the nearest marked feature; roots without features and broken/cyclic chains land in Unassigned. Existing none/status/area arrangements, filters, counts, sorting and row/detail selection remain usable. Feature labels remain available even when a filter hides the ancestor. Non-epic rows remain visible under Other items. No backfill, new endpoint, new contract field, connector rails or lane-board regrouping.

## Test plan

Extend the scoped tests before wiring the UI:

- Capability (Red today; expected absent implementation): pure cases: direct feature parent; multiple intervening epic/non-feature nodes; two marked ancestors chooses nearest defensively; unmarked root; absent/dangling parent; self-cycle and multi-node cycle; num/id resolution. Assert inputs are unchanged.
- Capability (Red today; expected absent implementation): grouping cases: two features with the same title stay distinct; deterministic section order; selected sort retained within each section; Unassigned appears exactly when needed; non-epic rows survive once under Other items; no duplicate/lost rows; empty results and unreadable items retain their existing behavior.
- Capability (Red today; expected absent implementation): filtering regression: hide both feature and intermediate ancestor while retaining an epic; assert the full-response lookup still places it correctly. Use titles containing HTML characters to assert escaped headings.
- Capability (Red today; expected absent implementation): mount cases: choose feature grouping through the actual select, filter to epics, select a grouped row and read its detail, refresh the response after changing ancestry, then reset to none. Assert labels/counts change together and no stale membership survives. Existing mounted status/reset coverage provides the harness (we:../plateau-app/src/backlog-view/mount.test.ts:316–344).

- Preservation (GREEN today; builder must confirm on base and branch): existing none/status/area grouping, sort/reset, empty and malformed rows, selection and total counts. Mutation proof: deliberately drop a non-epic row or bypass the existing status grouping branch and require the corresponding assertions to fail; restore the code before delivery. Extend the scoped list and mount suites cited above. Red/green labels here describe planned classification, not an executed test result.

In the Plateau implementation lane, run the two scoped Vitest files, then `npm test` (the script is `vitest run`, we:../plateau-app/package.json:14). This preparation itself changes documentation only; these are future implementation acceptance tests, not tests claimed as run here.

## Proof plan

Serve the implementation lane's Plateau application and load a deterministic backlog fixture through the normal read port. Include two features, a deep epic chain, a feature-less epic, a dangling reference, a cycle and a non-epic row. Operate the real grouping selector; record section labels, epic identities and counts. Filter out ancestors, select an epic, refresh with changed ancestry, and reset. Capture the observed DOM or screenshots and the served response used for the probe. Check keyboard operation and accessible selector naming against the existing labeled select (we:../plateau-app/src/backlog-view/backlog-view.ts:503).

Acceptance requires both passing tests and observed rendered grouping; parser/unit success alone does not prove the consumer is wired. This evidence can support #2733's later human review, but does not itself approve or refreeze another screen. For this card-only preparation, stamp with `node we:scripts/backlog.mjs prepare-stamp 3134`, run `node we:scripts/verify-lane.mjs`, and report actual results.

## Follow-ups

- Reconcile #2998's open status and mixed declared scope against its delivered WE work in a separately authorized change; do not silently clear this card's blocker.
- Review #2733's baseline prerequisites separately after consumer delivery; do not claim automatic human acceptance.
- Testing lesson: ancestry must use the complete response even when the displayed set is filtered; a pure helper test cannot catch a renderer passing the wrong collection. Keep that regression in the mounted/list tests, not shared agent documentation.
