---
bornAs: xxx881r
kind: story
size: 3
priority: high
parent: "4075"
status: open
blockedBy: ["4281", "3007"]
scope: ["we:scripts/lib/pr-events.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-09-27"
tags: []
relatedTo: ["3038"]
---

# PR ledger slice 2c: labels become display-only, the ledger is the source of truth

Slice 2 of webhooks-not-polling. With per-PR state derived from events (4281) and the verdict ledger as merge authority (#3007), stop treating review:* / ci:failed / ready-to-merge labels as state: daemons and the drain read the ledger, and labels are written only as a mirror for humans. Includes the jury ledger moving to the shared store (#3038) so every reader sees one ledger. Define the label-drift rule (ledger wins; a hand-applied label is an input event, recorded, not trusted).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
