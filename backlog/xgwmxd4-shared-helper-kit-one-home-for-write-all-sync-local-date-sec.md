---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["x3xrhfl"]
scope: ["we:scripts/kit/**", "we:scripts/lib/write-all-sync.mjs", "we:scripts/lib/local-date.mjs", "we:scripts/lib/secret-scrub.mjs", "we:scripts/lib/under-test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Shared helper kit: one home for write-all-sync, local-date, secret-scrub, constellation-repos, under-test

About 650 lines of tiny helpers are imported by every group (write-all-sync has 19 importers). Move them into scripts/kit/ with forwarding files at the old paths, so the later package move has one shared kit (@longshore/kit) and the boundary count drops.

## Acceptance

- [A1] **Executable** — a unit test imports every helper from `scripts/kit/` and from its old path and gets the same function object.
- [A2] `scripts/kit/` imports nothing outside itself and Node built-ins.
- [A3] The boundary count drops for the "everyone to tiny helpers" edges and the allowlist is lowered to match.

## Non-goals

- [N1] Rewriting every importer now; old paths stay as forwarding files until the package move.
