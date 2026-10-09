---
bornAs: xf4av69
kind: story
size: 5
priority: high
parent: "4075"
status: open
blockedBy: ["4125", "4127", "4134", "4121"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lane-drain.mjs", "we:scripts/readiness/drain-lock.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# First adopter: the drain's post-merge follow-up becomes a durable queued job, done once per pass under the numbering lock

Slice of decision 4120 (daemon job model); audit we:reports/2026-09-24-daemon-blocking-antipatterns.md. Filed uncleared until 4120 is ratified; the shape below follows its bold defaults and changes with the ruling. Findings D2, D8. Today we:scripts/merge-ai-prs.mjs lines 4683-4880 run the post-merge work inline after the merges: pull, primary sync, JIT numbering, resolve-on-land, push, derived regen. The next pass cannot merge anything until it ends (observed 7-17 min today; most of it is D1, fixed by 4127, after which the follow-up is about 30 s), and a kill mid-way (45-min pass timeout, or a daemon restart whose clone refresh does reset --hard) loses the local numbering commit. Adversarial round constraints: this kind changes a git tree, so under 4120 Fork 2 it does NOT run from a code snapshot; it runs in its own dedicated working tree of main (never the daemon clone the next pass refreshes with reset --hard), with the hash ledger pinned to the state root, and holds the numbering lock with a heartbeat and no unlocked fallback (4134). Resolve-on-land cannot re-derive its input from main, so the job record must carry the pass's landed ids and carriers. The daemon's releaseAndExit must stop killing this job (#drain-daemon-self-hosting-boundary clause 2 amendment in 4120). Adopt after 4127, 4134 and 4121 land, and after the health daemon has proved the core. Shape: the merge loop records one follow-up job per pass (the merged set) and returns; a single serial follow-up job, holding the numbering lock with a heartbeat, drains the queue in a batch; each step is idempotent (numbering re-derives pending hashes from main; resolve checks status first; regen is deterministic). The merge loop keeps merging while follow-up runs; the ordering invariant (resolve only after the whole couple landed) is kept by reading the merged set from the record. Done when: tests for crash between steps; LIVE proof: a pass that merges 3 WE PRs ends within 90 s of its last merge, and the follow-up job's record shows numbering and push done once (timestamps in the PR).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
