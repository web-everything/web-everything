---
bornAs: xqpz3zp
kind: story
size: 8
parent: "5488"
status: open
blockedBy: ["5482"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/conformance/**", "we:scripts/__tests__/check-standards*.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Split check-standards rules and runner into rule packs: web, backlog, delivery hygiene

Cut the biggest tangle in place: we:scripts/check-standards-rules.mjs (4,446 lines) and we:scripts/check-standards.mjs mix web rules, backlog rules and repo-hygiene rules and import delivery code. Split them into three rule packs behind a small pack loader, so each pack can later ship from its own home (web pack to everstandards, backlog and delivery packs to Longshore).

## Acceptance

- [A1] **Executable** — `npm run check:standards` output is identical before and after (same findings per rule, compared by a recorded snapshot in the PR).
- [A2] Three packs exist (web, backlog, delivery hygiene), each a module with its own rule list, loaded by a small pack loader; the web pack imports nothing from delivery code.
- [A3] `BACKLOG_KINDS`, `LOCI` and `validateBacklogItem` live in the backlog pack; old import paths still resolve through re-exports.
- [A4] The boundary count for standard to core and core to standard drops, and the allowlist is lowered to match.

## Non-goals

- [N1] Moving packs to another repo or package (the runner slice and the package move do that).
