---
bornAs: xdu2nw6
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/flows/daemon-rebuild.flow.json", "we:scripts/conveyor/soak/breaks/scorecard-dirt.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/conveyor/soak/breaks/__tests__/scorecard-dirt.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Make the flow-cite gate check semantic anchors: each cite carries a symbol name, and a check:stan… (from web-everything/web-everything#4009 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4009's review (reviewed head `b84af65079d0155457d1485cc4b5e14204a83a97`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/flows/daemon-rebuild.flow.json:61` — Make the flow-cite gate check semantic anchors: each cite carries a symbol name, and a check:standards or real-flows rule asserts that the symbol appears within the cited line range.
2. `we:scripts/conveyor/soak/breaks/scorecard-dirt.mjs:43` — Add a gate that every fixedBy.paths entry still contains the code its fix commit touched, for example by dry-running `git apply -R --check` for each break at open. Otherwise add a lint listing all repo references to a path that a move-only PR relocates.
3. `we:scripts/lib/daemon-rebuild/plan.mjs:17` — Add a unit test that every file under scripts/lib/daemon-rebuild/ is matched by REBUILD_MECHANISM_PATHS, plus a pinnedStatus test with an overlay touching only a folder file. Better, a check:standards rule that walks the folder and fails when a file is not covered by a mechanism path.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
