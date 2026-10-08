---
bornAs: xfneuba
kind: story
size: 3
parent: "5488"
status: open
scope: ["we:config/constellation-ownership.json", "we:scripts/lib/constellation-ownership.mjs", "we:scripts/lib/__tests__/constellation-ownership.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Constellation ownership map: classify every WE path by destination, all non-Longshore implementation to Plateau

Re-classify the split map under ruling S4: WE keeps zero implementation (definitions plus validate/conformance tooling only), the conformance runner and web rule pack go to everstandards, delivery machinery goes to Longshore, and every other piece of implementation (dashboards, site build helpers, docket, progress board, usage report and the like) goes to Plateau. Output is one declared path-glob to destination file, the input the boundary guard reads.

## Acceptance

- [A1] **Executable** — `node we:scripts/lib/constellation-ownership.mjs classify --json` assigns every tracked file to exactly one destination (`standard-def`, `everstandards-conformance`, `longshore`, `plateau`, `repo-local`, `data-by-topic`); a unit test fails on any unclassified or double-classified path.
- [A2] Under ruling S4, no path classified `standard-def` is implementation: anything that runs (dashboards, site build helpers, docket, progress board, PR view, usage report, dev tools) is `longshore`, `plateau` or `everstandards-conformance`. The test lists the reclassified paths against the plan's original map.
- [A3] The conformance runner, the web rule pack and validators are `everstandards-conformance` (ruling S3); delivery hygiene and backlog rules are `longshore`.
- [A4] The map's per-destination file and line totals are printed and recorded in the PR body as the new baseline for the epic.

## Non-goals

- [N1] No file moves and no import changes; this only classifies.
- [N2] No gate rule; the boundary guard is its own slice (#5482).
