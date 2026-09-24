---
bornAs: x8w8pux
kind: story
size: 3
parent: "3443"
status: open
scope: ["we:scripts/graduation-import-check.mjs", "we:scripts/__tests__/graduation-import-check.test.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Graduation import check: flag a slice whose files import a module owned by a later slice

Under epic we:backlog/3443, each porting slice (we:backlog/NNN-graduate-*.md) declares a scope: of we:-prefixed paths. Twice a slice's scoped test files imported a module owned by a LATER slice not yet on main, breaking the port. Build we:scripts/graduation-import-check.mjs: for every open card parented to #3443, read each scoped .mjs file at a snapshot ref, statically resolve its imports, and classify each import as on-main / own / blocker / later:#NNN / unowned. Report proposed fixes (move a later-importing test to the owning card, or add blockedBy for an impl file) and support --apply to write the fix into card frontmatter/notes.

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/graduation-import-check.test.mjs` passes (fails before this item lands: the module does not exist).
2. **Executable** — `node we:scripts/graduation-import-check.mjs --snapshot=600acc14f --parent=3443 --json` run against the real backlog flags #3895's `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` and `we:scripts/operations/__tests__/telemetry.test.mjs` (both import a later slice's module) before this lands; after `--apply` moves those two test files to their owning cards, the same command reports zero findings for #3895.
