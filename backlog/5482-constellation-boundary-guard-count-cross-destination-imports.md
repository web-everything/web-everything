---
bornAs: x3xrhfl
kind: story
size: 3
parent: "5488"
status: open
blockedBy: ["5481"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/constellation-boundary.mjs", "we:scripts/lib/__tests__/constellation-boundary.test.mjs", "we:config/constellation-boundary-allowlist.json"]
dateOpened: "2026-10-08"
tags: []
---

# Constellation boundary guard: count cross-destination imports, can only go down

Add a check:standards rule that reads the ownership map and counts import edges that cross destination groups (about 200 today). The count is a ratchet: it may only go down, and a new cross edge fails the gate. No file moves.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a scratch file that adds a new import from a `standard-def` path into a `longshore` path, and passes when the import is removed.
- [A2] The rule reports today's cross-group edge count per pair (standard to core, core to standard, core to Plateau, and so on); the allowlist holds exactly today's edges and a test proves the count can only go down.
- [A3] Test files are counted apart and never block.

## Non-goals

- [N1] Cutting any edge; the tangle-cut slices do that.
