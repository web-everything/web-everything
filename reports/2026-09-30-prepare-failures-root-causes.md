# Prepare failures: evidence and fix-cited disposition — 2026-09-30

The nine holds are not one failure. Four have a cause addressed by a landed fix; five stay held. The numbers #3046, #3051, #3053 and #3079 in this incident denote **pull requests**, not the unrelated backlog cards with those numbers.

## Per-item findings

| Item | Observed cause | Removing fix | Run evidence (UTC) |
|---|---|---|---|
| #4319 | unknown: zero-file result, worker reason lost | unknown/unfixed | `dispatch-lane-f13537e4-8b2a-4e84-b116-f7d5318dd426`; `pid:23225`; 2026-09-30T03:17:43.666Z |
| #4322 | unknown: zero-file result, worker reason lost | unknown/unfixed | `dispatch-lane-6a687da5-1486-46e7-a785-e9da05a7f8e3`; `pid:97174`; 2026-09-30T03:48:28.657Z |
| #4325 | result-lost: stamp refused 6 bare code paths | PR #3051 | `dispatch-lane-d771058d-c8b9-4077-878d-a72b82c4443c`; `pid:15659`; 2026-09-30T03:49:13.129Z |
| #4326 | result-lost: stamp refused 12 bare code paths | PR #3051 | `dispatch-lane-e74c981a-f524-439e-a6bd-ebc25ab6e281`; `pid:64938`; 2026-09-30T04:07:33.586Z |
| #4327 | result-lost: stamp refused 7 bare code paths | PR #3051 | `dispatch-lane-50d5001d-0f30-4b6e-91e4-efbaae11caf4`; `pid:49076`; 2026-09-30T04:11:10.857Z |
| #4328 | unknown/unfixed: explicit obsolete-scope/premise refusal | unknown/unfixed | `dispatch-lane-a8d41948-6b96-4aa8-acff-065e736882fe`; `9f40139a`; 2026-09-30T05:12:55.894Z |
| #4329 | agent-stopped-early: runner-owned completion in Claude brief | PR #3053 | `dispatch-lane-8e292b95-55a3-401c-9b3d-0c342700eafd`; `641f3cc9`; 2026-09-30T05:13:45.910Z |
| #4560 | unknown/unfixed: scratch cwd has no origin; subsequent acquisition denied | unknown/unfixed | `dispatch-lane-8e1a85cb-28ae-4cb2-8d59-0721684db8e3`; `d7ac9291`; 2026-09-30T00:51:20.773Z |
| #4561 | unknown: zero-file result, worker reason lost | unknown/unfixed | `dispatch-lane-92ce13f1-10d5-4c11-8e9a-8ab56b9479e5`; `pid:98806`; 2026-09-30T03:16:41.747Z |

## Evidence inspected

Run records: `~/workspace/.operations/coordination/build-dispatch-runs/`, exact basenames above. Detached worker output: `~/workspace/wev-control/.operations/delivery-dispatch-logs/prepare-item-N.log`. All six Codex attempts have scorecards in `~/.claude/daemon-self-sync-state/conveyor-state/.conveyor/run-scorecards.json`: three zero-file gate-red outcomes, then three authored-result escalations (43, 49 and 51 changed lines respectively). No Antigravity attempt is present in this incident.

Claude transcripts were found by scanning `~/.claude/projects/**/*.jsonl` for the prepare-item prompt naming each item. The three matching original sessions are:

- `~/.claude/projects/-Users-nicolasgilbert-workspace--operations-dispatch-3460b464-9e3d-49c4-8096-38fd46df8d18/641f3cc9-3785-475e-9bea-3441bbc46428.jsonl`
- `~/.claude/projects/-Users-nicolasgilbert-workspace--operations-dispatch-750d612b-a7cc-44e1-89b4-4dfb75a186e6/9f40139a-b6ea-4fb4-8cec-8e0ebc137c72.jsonl`
- `~/.claude/projects/-Users-nicolasgilbert-workspace--operations-dispatch-4c64e3d7-d104-4055-aa9e-bee8832333b3/d7ac9291-1499-4a70-9c6f-51bdb980c51f.jsonl`

#4329's final answer explicitly says it authored all five sections, omitted checks/stamp/commit/PR, and that the runner owns those steps. Its prompt starts with the probation-worker instructions even though the dispatch executor is Claude. PR #3053 (`3b4df6c061277450ab831dad7ffb896ed46aebd3`) separates the worker brief from the standalone agent brief.

#4328's final answer explicitly refuses because its scope points to #4309's card, two requested guards belong to a discarded write-queue/op-id design, and only the third is applicable. The bad brief was present, but that does **not** prove it caused this refusal. It stays held.

#4560's final answer and tool history show an acquisition error (scratch cwd has no origin URL), followed by a classifier denial on the explicit-origin attempt. No successful acquired worker lane or card edit exists. Neither the brief separation nor dead-worker retirement proves this combination fixed.

The six detached logs separate a generic zero-file refusal from stamp validation failure. PR #3051 (`85c9d572820ec4ba8326bf066192cdcff9e548c4`) added locus-qualified worker instructions, a repair pass driven by the actual stamp diagnostic, and retained decline reporting. The three locus failures are therefore eligible for a fix-cited release. For the zero-file group, improved diagnostics do not retrospectively recover the missing worker reasons: the original cause remains unknown. No matching Claude transcript exists for these Codex attempts; absence from Claude's store is not evidence of no Codex session.

## Claims and retirement history

The central `item-prepare-dispatch-claims/` directory is now empty. The primary/control `skills-src/batch-backlog-items/claims.json` files contain no matching prepare session, and no retained prepare-hold file was found there. These are current-state stores, not an append-only history. The durable historical observations available are the dispatch records and `~/workspace/.operations/coordination/build-dispatch-daemon.log`:

- #4560 retired at 01:04:07Z; #4319/#4561 at 03:44:47Z; #4322 at 04:03:35Z; #4325 at 04:07:33Z; #4326/#4327 at 05:09:40Z; #4328/#4329 at 06:08:59Z.
- Each first retirement says `dead prepare owner past heartbeat TTL`, `released: true`. That is a lifecycle observation, not the worker's cause of failure.
- The nine physical hold records still say `prepare-unstamped`; inspection at 11:20Z shows renewal by daemon PID 38801.

PR #3046 repairs slot starvation and mechanical completion for authored sections visible on main/a PR. It does not explain a worker refusal or recover discarded lane output. PR #3079's dead-session retirement likewise addresses resource release, not the underlying authoring failure. Neither is cited as an item-cause fix here.

## Release and route disposition

The reviewed data in `we:scripts/conveyor/prepare-failure-releases.json` authorizes exactly #4325/#4326/#4327/#4329, bound to each original run id and a full ancestor fix commit. It is consumed before slot planning and suppresses re-holding from the same historical result. New attempts are not covered. No route release is supplied: the three unknown zero-file attempts still block a defensible return to Codex. Route releases use `route:prepare` with exact `handle:scoredAt` attempt keys and the same validation. No timed route probe exists.

**Live release was not performed.** The coordination directory is outside this session's writable roots; the user also requires an uncommitted diff for human review. The manifest becomes effective when the reviewed daemon is run. No daemon, landing job, commit, push or PR was started by this investigation.

## Prevention cards

- #xsyqctd: recover/diagnose the unexplained zero-file group (#4319/#4322/#4561).
- #x1b9pdf: reconcile obsolete scope/premise on #4328.
- #xs57t0g: prove authorized scratch-session acquisition for #4560.

All three were filed locally through the declared `file-item` operation with queue disabled, so they remain reviewable in this diff. Unknown future failures use the existing detached prevention landing-job seam in daemon production, with a durable per-cause reservation; a spawn failure is recorded and never treated as a filed card.

## Verification

- `npx vitest related <all changed and newly added files> --run`: **8 files, 362 tests passed**. Includes class persistence, transient-only bounded retries, unknown card deduplication and hold, exact-attempt release, new-attempt protection, route release gating, transcript evidence and recovery-job retry policy. The probation regression also checks the persisted cause and diagnostic evidence.
- Real manifest read verified all four full fix commits are ancestors of this checkout.
- `node skills-src/conveyor/build-dispatch-daemon.mjs --bogus-flag`: **exit 2**, usage output, no boot exception.
- `git diff --check`: passed.
- `npm run check:standards`: **blocked before standards checks**. Its admission wrapper attempted to create a lock under `~/workspace/.lanes/.admission/heavy/`, outside this session's writable roots, and received EPERM. The admission gate was not bypassed. A human must run this gate in an environment permitted to acquire the shared admission lock.
