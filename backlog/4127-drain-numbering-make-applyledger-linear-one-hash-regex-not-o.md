---
bornAs: xn6n5gp
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/backlog/id.mjs", "we:scripts/lane-drain.mjs", "we:scripts/backlog/__tests__/id.test.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-25"
dateResolved: "2026-10-09"
graduatedTo: 5bfe2180c
tags: []
---

# Drain numbering: make applyLedger linear — one hash regex, not one regex per ledger entry per line

Audit we:reports/2026-09-24-daemon-blocking-antipatterns.md finding D1 (just speed it up, P0). we:scripts/backlog/id.mjs swapHashes (line 107) builds a new RegExp for EVERY ledger entry on EVERY line, and applyLedger (line 171) calls it per line plus a per-entry path regex per file. numberPendingHashes in we:scripts/lane-drain.mjs runs it over the whole corpus (4,386 files, 299k lines) with the drain clone's append-only ledger (1,394 entries). Measured in memory on 2026-09-24: 441 s of pure CPU per numbering pass. It grows with both the corpus and the ledger, forever. Live symptom: on every pass that numbered a hash today, the numbering commit landed 8 to 17 min after the merges (a pass with nothing to number took 34 s). It also runs inside the 5-minute numbering lock (we:scripts/readiness/drain-lock.mjs NUMBERING_LEASE_MINUTES), so the lock TTL expires mid-section and a concurrent lander may reclaim it. Adversarial round: about 76% of the cost is the per-entry PATH regex (lines 193-202 of the same file, one lookbehind regex per ledger entry per file, each scanning the whole file), not swapHashes, so the fix must cover both. The same numbering also runs from we:scripts/pr-land.mjs (around line 1146), we:scripts/lib/number-pending-hashes-before-push.mjs (line 66, before every push to main while a hash file is tracked) and we:scripts/backlog.mjs (around line 1191), so this one fix speeds all four. Fix shape: one regex for the hash token shape, looked up in a Map; skip files with no hash token at all; same for the path-rename scan. Output must be byte-identical to today's. Done when: (1) a unit test proves identical output on a fixture corpus; (2) the same in-memory benchmark (whole corpus, live ledger) runs under 5 s, before/after numbers in the PR; (3) LIVE timing proof: the next drain pass that numbers a hash shows merge-to-numbering-commit under 60 s (git log timestamps vs PR mergedAt), quoted in the PR or a follow-up comment. Coordinate with the in-flight drain timing worker (it owns we:scripts/merge-ai-prs.mjs step timing, not this file).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
