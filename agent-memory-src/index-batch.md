---
name: index-batch
description: "Batch execution and commit/git discipline: claim before coding, points-budget is the sole stop, batch conflict avoidance via per-item claim, gate-red stop scoped to own files, commit per finished piece with tight pathspec, never push, never git add -A, concurrent staged-index sweep, concurrent resolve revert (verify it persisted), commit on the current branch. Recall when batching items or committing work."
metadata:
  node_type: memory
  type: reference
  originSessionId: e9b47075-174d-4038-a5a5-012037ccbbeb
---

Batch · Commit · Git Hygiene cluster — open a leaf with `node scripts/memory-resolve.mjs <N>` (or `--cat`):

- 50. Gate-Red Stop Scoped To Own Work — batch gate-red stop = ONLY the batch's files; step over concurrent red; #664
- 61. Batch Working Practices — claim before coding; pre-flight forks; cluster by repo
- 63. Batch: Never Self-Judge a Stop — points budget=SOLE stop driver; never self-judge mid-run; 4 hard stops
- 101. Commit Each Finished Piece, Never Push — commit per closed item, staging ONLY that piece's files; never push/`add -A`
- 102. Concurrent Sessions Sweep Staged Index — others' `git add -A` can swallow my staged work; commit tightly; #1147
- 103. Concurrent Resolve Revert — concurrent write can revert `resolve` pre-commit; verify it persisted; #1742
- 104. Edit-Work Runs In A Lane Clone — edits land via lane-clone → ready-to-merge PR, NEVER direct to main (#2183/#2190); never branch a shared checkout; [[single-session-should-use-a-lane]]
- 147. `gh pr create` Lands Unreviewed — no `review:*` label = NOT a hold; drain mints ready-to-merge on green and merges; use `pr-land` or apply `review:pending` in the same step; #2929
- [Lane→PR is universal delivery for ALL repos](lane-pr-is-universal-delivery-all-repos.md) — every repo (WE/FUI/plateau-app) delivers ONLY via lane→PR; the tooling is SHARED (`lane-pool`/`pr-land --repo=<repo>`), so a repo lacking its own script does NOT mean it lacks the flow — never assume a repo is exempt from a scripts/ glance; apply the loaded invariant, don't re-derive from local absence; 2026-07-19
- 122. Batch Conflict Avoidance — per-item claim (status:active) dodges races, NOT git-status; splice data edits
- [Monolith-split vs partition for parallel capacity](monolith-split-vs-partition-capacity.md) — only entry-COLLECTIONS split; for docs/matrices/sweeps the lever is a precise pairwise partition + optimistic merge, not splitting; #1949
- [Parallel /workflow works incl cross-repo](parallel-workflow-blocked-by-git-guard.md) — clone model + lane/* push carve-out; 2026-07-01 16/18, cross-repo couples merged green; primaryRoot moot
- [/workflow cross-repo false-drop FIXED](workflow-crossrepo-lanes-falsedrop.md) — cause: stale impl origin/main; sync origins first; NEW gap: unscoped impl gate blocks landing #1965
- [never-push guard removed](never-push-guard-removed.md) — push to main now allowed (user 2026-06-29); branch/broad-stage guards stay; FUI+plateau remotes →SSH
- [Shared pool lane unsafe for manual work](shared-pool-lane-unsafe-for-manual-work.md) — peer /workflow can reset --hard + clean -fd a shared lane; use dedicated clone outside .lanes/ + commit-push early
- [Keep local main current after merge](keep-local-main-current-after-merge.md) — post-merge sync = `git pull --ff-only --autostash`; dirty tree must never leave main behind; #2183
- [Closeout never infers ownership from dirty tree](closeout-never-infers-ownership-from-dirty-tree.md) — scope to own changeset; never revert files you didn't write; ratified invariant #1985
- [Parallel orchestrator: first multi-lane run](parallel-orchestrator-first-real-multilane-run.md) — #1153 validated; carried items land active-unclaimed → reopen at closeout
- [pr-land dogfood mechanics](pr-land-dogfood-mechanics.md) — --park is the only unconditional hold (--no-wait / --label=NAME are not); --body-file; behind-main→rebase; --admin blocked; gh-pr-create 401→REST; self-heals id collisions; #2181
- [Shared-file staging sweeps concurrent hunks](shared-file-staging-sweeps-concurrent-hunks.md) — `git add` stages foreign hunks; diff before staging, verify sha after commit
- [Shared-index commit race](shared-index-commit-race.md) — peer session's `git commit` can sweep YOUR staged files; stage+commit in one step; #2138
- [Single session should use a lane](single-session-should-use-a-lane.md) — RULED #2123: every edit-action session runs in an isolated lane CLONE; no carve-out
- [Lane refresh wipes unmapped lanes](lane-refresh-wipes-unmapped-lanes.md) — map/own a lane before editing; refresher hard-resets idle clean lanes to origin/main mid-work
- [Producer opens PR, drain reviews](producer-opens-pr-drain-reviews.md) — DECIDED 2026-07-02: lanes open draft PRs, drain reviews+merges; drop self-approve
- [Sweep review findings to closure](sweep-review-findings-to-closure.md) — a produced PR w/ an advisory finding isn't done till FIXED (commit+comment) or DISMISSED (comment+label); review:human is human-only via /review; #2365
- [Batch item can silently reverse a codified rule](batch-item-can-silently-reverse-codified-rule.md) — a story can reverse a rule codified only in code; grep it, reclassify to decision; #2149/#1952
- [No work EVER in the primary checkout](no-work-ever-in-primary-all-repos.md) — the EDIT itself runs in a lane clone (every repo: WE/plateau-app/FUI), no carve-out; #2203 blocks the push, this blocks the touch
- [Backlog id-storm buffer + lane→PR](backlog-id-storm-buffer-and-lane-pr.md) — hand-picked max+1 ids collide under concurrent sessions (dup id → CI red); buffer max+~6, verify no dup, land via lane→PR
- [Parallel /workflow touches primary](parallel-workflow-touches-primary.md) — new-item batch needs items on origin/main before lanes claim → direct push + queued.json write break lanes-only-via-PRs; first-lander manifest LEAK fixed #83; drain rebase-drop can't resolve bare lane/… ref in a fresh clone
- [Lane guard bypass only for personal config](lane-guard-only-bypass-for-personal-config.md) — LANE_GUARD_OFF is ONLY for gitignored use config (settings.local.json, ~/.claude/*); tracked project files → lane + PR, never bypass; `git check-ignore` to decide
- [guard-bash matches the push substring](guard-bash-matches-push-substring.md) — the Bash guard denies ANY command whose text contains the literal push phrase (even a grep/echo/comment), not just a real invocation; reword the search, don't override
- [Drain is a resident daemon](drain-is-a-resident-daemon.md) — installed 2026-07-13 as a launchd agent; auto-lands ready-to-merge PRs every 60s; don't manually /drain while resident; verify via `cli.mjs status`; #2449
- [Plateau loop runs on the dev laptop, keep it simple](plateau-loop-runs-on-dev-laptop-simple.md) — short-term the drain daemon runs from the dev laptop in dev mode; priority = simple + running, NOT self-update; don't build #2468, #2501 PREPARED+SHELVED until it leaves the laptop (2026-07-14)
- [A draft alone does not hold a PR](draft-alone-does-not-hold-a-pr.md) — draft-promotion promotes green lane/* drafts; hold with draft + review-status:draft-withdrawn, or review:changes via review-set-label
