---
bornAs: x4u6m1b
kind: task
status: open

dateOpened: "2026-09-29"
tags: []
---

# Fix #3809 card target: wip-report lives on lane/mechanical-dispatcher, not main

#3809 (the /wip report readable on a phone) is marked prepared but its scope (we:scripts/operations/wip-report*.mjs) does not exist on main — the files live on the prototype branch lane/mechanical-dispatcher (Codex found this 2026-09-29 and changed nothing). Re-prepare it: either set deliveryTarget to that registered POC branch, or re-scope it against main. Until then it must not be offered to builders or workers.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Findings (standalone worker, 2026-11-18)

The build-dispatch daemon held #4553 with:

> worker-declined: Not prepared: #4553 — could-not-prepare. #3809 was marked resolved by 'f9426a3d43', but local prototype evidence still shows title truncation, no '--full' flag, and missing planned readability tests. The unresolved choice is whether to reopen #3809 or retain its resolution based on delivery evidence unavailable locally. I cannot honestly report already-done or prepare a repair that assumes either choice. No files changed or stamped; no tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
