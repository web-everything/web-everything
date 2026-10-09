---
bornAs: xgqueiz
kind: story
size: 5
parent: "5488"
status: open
blockedBy: ["5492"]
scope: ["we:scripts/longshore-mirror/**", "we:docs/agent/longshore-mirror.md"]
dateOpened: "2026-10-08"
tags: []
---

# Create the private longshoreai/longshore mirror by filter-repo, after a full-history secret scan

Ruling S5: extract packages/longshore with its full history (including earlier path names) via git filter-repo into a private longshoreai/longshore repo, run a secret scan over the whole extracted history first, and fall back to a squashed fresh start plus a pointer to WE if the scan finds anything. The mirror is read-only, synced from WE main on each land.

## Acceptance

- [A1] **Executable** — the extraction script rebuilds the mirror from WE main and its own test suite passes standalone.
- [A2] A secret scan over the whole extracted history is clean and its report is linked; if it is not clean, the mirror starts from a squashed snapshot with a pointer to WE (ruling S5).
- [A3] `git log --follow` works on 10 sampled files across their earlier names.
- [A4] The mirror is private and read-only; a sync after each WE land keeps it current. The repo identity registry (#5502) has a `delivery-core` entry for it. Add `5502` to `blockedBy` once PR #4506 lands (the card is not on main yet, so the gate refuses the edge today).

## Non-goals

- [N1] Making it public (needs the flip and a fresh scan, ruling S6).
