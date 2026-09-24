---
bornAs: xtidyi7
kind: story
size: 5
parent: "3383"
status: resolved
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Lane whois: trace every lane back to its session/card/PR, dry-run reclaim plan

Lease markers are deleted on release, so once a lane's lease is gone nothing records who used it, for what card/PR, or whether it is safe to reclaim. Adds a small lane-history ledger (one JSON line per acquire/adopt/release/reap, inside .git/ so it is never tracked/dirty), a new read-only we:scripts/lane-whois.mjs that reports current lease + holder-alive, last holder (ledger, or transcript-attribution/inference fallback), uncommitted/ahead summary with provable-preservation proof, card/PR status, and a four-way verdict (in-use / finished-reclaimable / finished-needs-review / unknown-work), and wires a best-effort needs-your-decision feed into we:scripts/operations/operator-queue.mjs (--with-lanes). Never resets/releases anything itself, dry-run only.

## Done when

1. **Executable** — `node we:scripts/lane-whois.mjs --lane=N --json` did not exist before this item (no such
   command, no `<lane>/.git/lane-history.jsonl` ever written by `we:scripts/lane-pool.mjs`); after, it reports
   lease/holder-alive, last holder (ledger or transcript-attribution), uncommitted/ahead + preservation proof,
   card/PR status, and a verdict — proven live against the real ~65-lane WE pool (read-only; see the PR body
   for the before/after counts and 5 example lanes with evidence).
