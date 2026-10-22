---
bornAs: xwu9oxh
kind: epic
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/review-evidence-at-head.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/operations/run-store.mjs", "we:scripts/conveyor/run-scorecard-store.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Memory audit: cut per-process RSS and duplicated loads across daemons/review jobs

Read-only memory audit of the host on 2026-10-20 (about 600 MB free, swap 4.9 of 6 GB used). The biggest single cost is three helpers that scan the whole review run store to find one PR's evidence: they list about 144,500 run files, then parse every one of the 6,553 review-pr runs (1.58 GB of JSON) per call. readReviewEvidenceAtHead and latestRun in readDrainRedTeamEvidence even hold all parsed runs in one array before filtering. Every review-job, review-extra-seats, review-set-label, red-team-gate-apply, advisory-label-sweep and drain pass repeats this independently, which is why those processes sit at 0.6 to 2.2 GB when their modules alone load in 120 to 155 MB. The second duplicated load is the 45 MB run-scorecards store, parsed in full by 24 modules, several times per process. This epic ranks slices by GB saved, and adds a target architecture of small local data services (review run store, PR store, backlog index, git diff cache) that each own one dataset and answer queries over a local socket, with a fail-closed fallback to today's direct read.

## Evidence (2026-10-20, read-only)

Method: `ps -Ao pid,ppid,rss,etime,args` samples at 13:45Z (operator snapshot) and about 14:05Z (this audit), code reading of the review daemon clone at main `ba33e7d2a0`, and one `node -e` import probe per entry point printing `process.memoryUsage()` (module cost only, no work run).

Module-load cost (import only): we:scripts/operations/review-job.mjs 154 MB RSS / 52 MB heap; we:scripts/operations/review-extra-seats.mjs 127 / 44; we:scripts/review-set-label.mjs 118 / 35; we:skills-src/conveyor/pass-daemon.mjs 64 / 11. So anything above about 150 MB in these processes is data, not code.

The run store: the shared runs directory holds 144,551 run files (30 GB on disk). 6,553 are `review-pr-*` (1.58 GB). Single `close-items-*` runs are about 40 MB each. The scorecard store is 45.7 MB of JSON.

Full-scan readers that look up ONE repo/PR/head by parsing EVERY review-pr run:

- we:scripts/lib/review-evidence-at-head.mjs `readReviewEvidenceAtHead` — `listRunIds().filter().map(readRun)` keeps all 6,553 parsed runs alive at once, then filters. Peak heap is roughly the whole 1.58 GB parsed (2 to 4 GB of objects).
- we:scripts/lib/drain-red-team-evidence.mjs `readDrainRedTeamEvidence` → `latestRun` — same pattern (map to `{id, run}` before filter). It also calls `readSavedRedTeamResult` and parses the full scorecard store.
- we:scripts/lib/saved-red-team-provenance.mjs `verifySavedRedTeamProvenance` — streams one run at a time (lower peak) but still reads and parses all 1.58 GB per call. Reached from we:scripts/lib/drain-saved-red-team.mjs `savedRedTeamFallback`, which is used by review-job, review-set-label, red-team-gate-apply and operator-why.

Callers: review-job (lines near 292, 303, 311), we:scripts/conveyor/advisory-label-sweep.mjs (once per labelled PR in a loop), we:scripts/lib/drain-merge-strategy.mjs (drain and review daemon), we:scripts/review-set-label.mjs, we:scripts/operations/red-team-gate-apply.mjs.

Live process tree, review stack (14:05Z sample):

- review-daemon (934 MB, long-lived) spawns one review-job per PR (13 live).
- review-job is either idle-waiting (about 43 MB, 7 of 13) with a review-loop-cli child (270 to 485 MB) and an extra-seats red-team-speculate child (84 to 480 MB), or in its evidence/red-team phase at 830 MB to 1.94 GB (5701: 1.94 GB, 5670: 1.51 GB, 5659: 1.27 GB, 5700: 1.07 GB).
- Duplication between parent and child: PR 5670 review-job 1.51 GB and its review-extra-seats child 1.35 GB at the same moment; PR 5700 review-job 1.07 GB and its extra-seats child 1.37 GB. Both levels run the same run-store scan for the same PR/head independently.
- PR 5689: review-job 329 MB and its red-team-gate-apply child 623 MB (savedRedTeamFallback scan).
- advisory-label-sweep (child of the advisory-label-sweep pass-daemon) at 2.22 GB: it calls readDrainRedTeamEvidence once per red-team-labelled PR, each a full scan.
- codex children are small (43 to 240 MB) and are not the problem.

V8 rarely gives heap back to the OS after a spike, so a long-lived daemon that does one full scan keeps that RSS for its lifetime (review-daemon 0.93 GB, reconcile-fix-dispatch-daemon 1.36 GB, plateau drain daemon 1.34 GB, build-dispatch-daemon 0.53 GB). Attribution for those three is suspected, not proven; slice S6 proves it.

## Per-kind table

| Kind | Count | RSS each | What dominates | Duplicated with | Fix | Est. saving |
|---|---|---|---|---|---|---|
| review-job | 13 | 43 MB idle; 0.8–1.9 GB in evidence phase | Full review-pr run-store scans (3 helpers) + full scorecard parse; modules 154 MB | Its own extra-seats and red-team-gate-apply children; every sibling review-job; drain; label sweep | Indexed per-PR lookup (S1); pass evidence down to children (S3) | 4–6 GB |
| review-loop-cli | ~10 | 270–485 MB | Modules + PR diff + judge outputs; backlog read is streamed one file at a time (fine) | Sibling loops each load the review core | Bounded concurrency (owned by the memory-aware admission cap work); slimmer entry | 1–2 GB (via cap) |
| review-extra-seats | 4 | 0.08–1.37 GB | Same run-store scans + scorecard parse (seat caps read the store up to 3 times per call) | Parent review-job, same PR/head | S1 + S2 + parent passes evidence (S3) | 1.5–2.5 GB |
| advisory-label-sweep | 1 (per tick) | 2.2 GB | readDrainRedTeamEvidence per PR, each a full scan | review-job, drain | S1 (and read the index once per sweep) | ~2 GB peak |
| review-daemon | 1 | 0.93 GB | Retained heap after scans via drain-merge-strategy; module graph | drain, sweep | S1, then S6 confirms | 0.5–0.8 GB |
| reconcile-fix-dispatch-daemon | 1 | 1.36 GB | Unattributed (40+ conveyor imports; likely retained scan or store parse) | other daemons | S6 heap attribution, then targeted fix | 0.5–1 GB |
| plateau drain daemon | 1 | 1.34 GB | Unattributed (plateau-app drain) | WE drain | S6 | 0.5–1 GB |
| review-set-label | 1 | ~0.5–0.6 GB | savedRedTeamFallback full scan; modules only 118 MB | review-job | S1 makes it cheap; slimmer entry for plain label sets | ~0.4 GB each |
| red-team-gate-apply | 1–2 | ~0.6 GB | readSavedRedTeamResult full scan | parent review-job | S1/S3 | ~0.5 GB |
| vitest | 8 | 50–640 MB | Test workers in lanes | — | Heavy-queue admission (existing) | out of scope |
| pass-daemon | 12 | 41–56 MB | One Node runtime + module graph per pass | each other | Optional: one host process runs many passes (S7) | ~0.4 GB |
| gh-throttle | ~10 | 55–58 MB | A whole Node process per `gh` call | each other | In-process throttle client or PR store service (S7, card xdk2pq6) | ~0.4 GB |
| verify-lane / verify-gate-job | 9 / 5 | 40–85 MB | Runtime + modules | — | none needed | small |

## Ranked slices (biggest saving first)

Delivery modes: DEBUG = hotfix, live proof first, loaded on a daemon overlay today (small, reversible by a setting, no new process, identical answers, immediate relief). PROTOTYPE = shadow first, then switch behind a setting (new service or process, new data source, or freshness/invalidation). PR = pure refactor, no live urgency.

| Slice | Est. saving | Mode | Why this mode |
|---|---|---|---|
| S1a filter-before-parse, one parsed run at a time | 4–6 GB peak | DEBUG | Under 100 lines in 3 helpers, identical answers, no new process, instant relief |
| S1b append-only review-pr index | +2–3 GB and CPU | PROTOTYPE | New data source with invalidation; shadow-compare against the scan first |
| S2a scorecard parse memo per process | 1–2 GB | DEBUG | Small mtime-keyed memo, identical answers, setting-reversible |
| S2b scorecard index + retention | further 0.5 GB, bounded growth | PROTOTYPE | Changes where rows come from; needs invalidation |
| S3 parent passes evidence to children | 1.5–2.5 GB | DEBUG | Small handoff with fallback to own read, identical answers, setting-reversible |
| S4 run-store retention | 0.2–0.5 GB per scan, ~25 GB disk | PROTOTYPE | Moves data; readers must find archived runs; dry-run first |
| S5 bounded review concurrency | 1–3 GB | DEBUG (owned elsewhere) | Owned by the memory-aware admission cap work; this card only supplies numbers |
| S6 daemon heap attribution | enables 1.5–3 GB | DEBUG | Read-only status field, no behaviour change |
| S7 fewer small Node runtimes | ~0.8 GB | PROTOTYPE | New shared host process / service |
| S8 slim review-set-label entry | ~0.1 GB each | PR | Pure refactor once S1 makes the scan cheap; no urgency |
| Data services (below) | see table | PROTOTYPE | New long-lived processes with freshness and fail-closed fallback |

1. **S1 — Indexed review-evidence lookup (est. 6–9 GB at peak across the stack).** Replace the three full-scan readers with one shared lookup keyed by repo + PR + head. Cheapest correct step: a small append-only index (one line per review-pr run: id, repo, pr, head rev, mtime, completed flag) written by writeRun and rebuilt from disk when missing or stale. Readers then parse only the matching runs. Interim fix inside the same slice: filter before parse and never hold more than one parsed run at once. Must stay byte-for-byte equal in answer to today's scan (proof: run both on the live store for every open PR, diff the answers). Mode: S1a (filter before parse) is DEBUG, S1b (the index) is PROTOTYPE.
2. **S2 — Scorecard store read once, filtered (est. 1–2 GB).** 24 modules parse the 45 MB store in full, several times per process (seat caps read it up to 3 times per call). Read once per process with an mtime-keyed memo, or keep a per-(repo, pr) index beside it, and add a retention/rotation policy so the file stops growing without bound. Mode: S2a (memo) is DEBUG, S2b (index and retention) is PROTOTYPE.
3. **S3 — Load once in the parent, pass down (est. 1.5–2.5 GB).** review-job already computes the PR/head evidence; hand the result to its review-extra-seats and red-team-gate-apply children (a temp file path or argv), so the child does not rescan the same data. Child falls back to its own read when the handoff is missing. Mode: DEBUG (small, identical answers, setting-reversible).
4. **S4 — Run-store retention (est. 0.2–0.5 GB per scan, plus about 25 GB of disk).** 144,551 files and 30 GB. Every listRunIds call materialises 144k names. Archive finished runs older than N days by op into per-op subfolders or a compacted archive; cap `close-items` run size (about 40 MB each). Mode: PROTOTYPE (moves data; dry-run first).
5. **S5 — Bounded review concurrency (est. 1–3 GB).** 13 review-jobs and about 10 review-loops ran at once. Do NOT build this here: the memory-aware admission cap being built by another agent owns it. This slice only records the per-review cost numbers above as input to that cap. Mode: DEBUG, owned by that work.
6. **S6 — Attribute the long-lived daemon heaps (est. 1.5–3 GB once fixed).** Add a cheap, opt-in heap summary to the daemon status (heapUsed, external, arrayBuffers, top retained data source) for review-daemon, reconcile-fix-dispatch-daemon, plateau drain daemon and build-dispatch-daemon, then file targeted fixes. Re-measure after S1, since retained scan heap is the leading suspect. The keep-alive leak fix in flight elsewhere may explain part of this; check it first. Mode: DEBUG (read-only status field).
7. **S7 — Fewer small Node runtimes (est. 0.8 GB).** gh-throttle spawns a whole Node process per `gh` call (about 57 MB each, about 10 live); 12 pass-daemons each carry their own runtime. Options: an in-process throttle client, the PR store service below, or one host process hosting many passes. Lowest priority: small per process, real only in aggregate. Mode: PROTOTYPE (new shared process).
8. **S8 — Slim entry for review-set-label (est. 0.1 GB each).** A plain label swap should not import the review core or run the saved-red-team fallback; split the light path from the verdict path. Mode: PR (pure refactor, no urgency after S1).

## Target architecture: light decoupled data services

Operator direction (2026-10-20): "light decoupled data services that can answer data-heavy operations". Small long-lived local services each own ONE heavy dataset and answer narrow queries over a local Unix socket. Review jobs, drain, label setters and pass-daemons ask the service instead of loading the dataset themselves. S1, S2 and S4 are the in-process first steps; each service is the end state for its dataset.

Rules shared by every service:

- **Versioned answers.** Every reply carries the dataset version it was computed from (for files: a generation counter bumped on each write event plus the source mtime; for PRs: fetchedAt plus head sha).
- **Freshness.** Event-driven first (the writer notifies the service on write, or the service watches its directory), with a timer reconcile to catch missed events. A caller can pass maxAge or a minimum version.
- **Fail closed.** Service down, slow (short timeout), stale beyond maxAge, or on a version or schema mismatch → the caller falls back to today's direct read. Never a guessed or partial answer. The service never decides a hold, a gate or a merge; it only answers lookups that the caller would otherwise compute from the same files.
- **Small and boring.** One process per dataset, read-only to callers, no network listener, socket in the per-user state dir, bounded memory (an index, not the full dataset in heap).

| Service | Owns | Replaces (who stops loading it) | Est. saving | Freshness / invalidation |
|---|---|---|---|---|
| Review run store service (first; ties to 6786) | Index of review-pr runs by repo/PR/head (id, completed, verdict, saved red-team proof ref), served from S1's index | review-job, review-extra-seats, red-team-gate-apply, review-set-label, advisory-label-sweep, drain-merge-strategy (review-daemon, drain) | 6–9 GB peak (largest duplicated load) | writeRun bumps generation and notifies; directory-watch backup; rebuild from disk on start |
| Scorecard service | Scorecard rows indexed by repo/PR/rev/seat, plus seat-cap usage counts | 24 reader modules across review stack and daemons | 1–2 GB | appendScorecard notifies; mtime check on each answer |
| PR store service (card xdk2pq6) | Open PRs: number, head sha, base, labels, mergeable, check rollup | Per-daemon `gh` list calls and the per-call gh-throttle Node processes | ~0.4–0.6 GB plus GitHub rate-limit relief | pr-events plus timer reconcile, per card xdk2pq6; holds still read live |
| Backlog index service | Card number → path, title, status, scope, kind | Processes that scan we:backlog/ (about 6,500 cards) to find one card or a scope overlap | small today (reads are streamed), mostly CPU and IO | git HEAD change or file watch on we:backlog/ |
| Git diff cache (maybe) | PR net diffs keyed by base and head sha | review-loop-cli, review-job, extra-seats each recomputing the same diff | 0.1–0.3 GB plus CPU | Content-addressed by sha pair, so never stale; LRU size cap |

First slice is the review run store, because it is the biggest duplicated load: the same 1.58 GB parse runs independently in every review-job, its children, the label sweep and the drain.

## Related work (reference, do not duplicate)

- Memory-aware admission cap (in flight by another agent) owns S5, the concurrency bound.
- Keep-alive leak fix (in flight by another agent) may explain part of the long-lived daemon RSS in S6.
- 6786: review run store epic; S1 and the run store service should land under or alongside it.
- xdk2pq6 (card 6520): host-wide PR store; the PR store service above IS that card.
- 3608 / 3611: heavy-command usage sampling and capacity control.

## Acceptance

- [A1] **Executable** — every slice proves its saving on the live host: before/after RSS of the named process kind from `ps`, sampled under the same workload, and for S1 an answer-equality diff between the old full scan and the new lookup for every open PR.
- [A2] After S1, no code path parses all review-pr runs to answer a single repo/PR/head question (a grep or lint guard for `listRunIds(...).map(readRun)` style scans).
- [A3] Every data service caller has a tested fallback to the direct read when the service is down, stale or on a version mismatch.

## Non-goals

- [N1] Not the admission cap or the keep-alive leak fix (owned elsewhere).
- [N2] No change to what any gate, hold or verdict decides; only how the same data is read.
- [N3] vitest worker memory is out of scope (heavy-queue admission covers it).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — run and scorecard files are local, written by our own tools; the index stores only ids and keys, and any unparseable run is skipped exactly as today.
2. **Truncated reads** — writeRun is already atomic (temp file + rename); the index must tolerate a half-written last line by ignoring it and rebuilding.
3. **Shared state files** — the index and services are written by one writer; many readers; a reader that finds the index older than the runs directory falls back to the scan.
4. **Fail closed** — service down, stale or version mismatch → direct read, never a guessed answer.
5. **Identity scoping** — keys include repo slug (case-folded, as today), PR number and head sha; no cross-repo answer.
6. **State over time** — runs are updated in place; the index records mtime so "latest run for this head" still picks the newest write.
7. **Who wrote it** — saved red-team provenance checks (writer, hash, references) stay in the caller; the service returns the run, the caller still verifies it.
