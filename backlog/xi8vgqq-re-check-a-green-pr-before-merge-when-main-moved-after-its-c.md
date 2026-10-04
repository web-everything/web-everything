---
kind: story
size: 5
parent: "x0hvbwx"
status: open
blockedBy: ["xcs4nce"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-recheck-main-moved.test.mjs", "we:scripts/lib/tested-main-base.mjs", "we:scripts/lib/__tests__/tested-main-base.test.mjs", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, drain, merge, freshness]
---

# Re-check a green PR before merge when main moved after its checks ran

Before merging, the drain checks whether main moved after the PR's green `test` run started. If it did, the
drain rebuilds the PR onto current main so CI runs again, and merges on a later pass. Governed by
`mergeGate.recheckWhenMainMoved` (default `if-older-than-N-min`, operator ruling 2026-10-03) and
`mergeGate.recheckMaxAgeMin` (default 30).

## Progress

Prepared 2026-10-03 against `838e849ab`.

| Premise | Checked against the code |
| --- | --- |
| The drain merges without re-testing against the newest main. | Confirmed. `classifyPr` (`we:scripts/merge-ai-prs.mjs:711-751`) needs `test` green and the state `CLEAN` or `UNSTABLE`. `revalidateForMerge` (`:785-797`) only pins the head SHA. The merge at `:5487-5493` uses `--match-head-commit`. Nothing compares main's tip. The serial loop (`:5253`, `:5294`) merges one PR after another in the same pass. |
| GitHub would report the PR as `BEHIND`. | **No.** Main's branch protection has `strict: false` (read with `gh api repos/chalbert/web-everything/branches/main/protection/required_status_checks`, 2026-10-03). So a PR whose green run predates the last merge still reads `CLEAN`. The `BEHIND` skip at `:745` never fires. |
| A plain CI re-run would re-check. | **No.** A re-run reuses the run's original merge commit, so it tests the old main again. The PR head must move. The rebuild plumbing already exists: `rebaseDropManifest` (`we:scripts/lib/rebase-drop-manifest.mjs`), used by the drain at `we:scripts/merge-ai-prs.mjs:4459-4560`. |

Related, not a duplicate: card #2824 refreshes review-held `BEHIND` PRs. This story is about ready, green PRs.

## Design

1. **Tested main revision, by commit identity, not by clock.** A run's start time does not say which main it
   tested: a rerun reuses the run's original merge commit, and a queued run can start after the main it
   merged against went stale. So "which main did this run test" is the **first parent of the merge commit the
   run checked out**.
   - **Provenance: the PR must not be able to choose this value.** On a `pull_request` run the workflow file
     comes from the PR's own merge commit, so a value the job publishes is the PR's claim, not a fact. The
     drain therefore **derives the tested main SHA itself** from data the PR cannot write. **Default: the
     exact one**, the first parent of the merge commit GitHub built for the event (`refs/pull/<n>/merge` as
     of the run's trigger), read through the API by the drain.
   - **No exact value means unknown, and unknown is never guessed.** There is **no timestamp fallback**. A
     commit date is not a push time, so "main's tip as of `created_at`" can name a commit the run never
     tested (a main commit pushed after the run was created can carry an older commit date, whatever
     safety margin is subtracted), and a guess that is wrong in that direction reads an untested main as
     tested. **"Exact" means pinned to the run, not read from the live merge ref**: the drain accepts a
     merge commit only when its second parent equals the run's `head_sha` (the PR head the run built) and it
     comes from a source tied to the run (the run's checkout record), never from `refs/pull/<n>/merge` as it
     stands now, which GitHub rebuilds when main moves and whose first parent would then be a newer,
     untested main. When no such pinned merge commit is available (the merge ref was deleted or rebuilt, the
     second parent does not match, the call fails, or the field is absent), `readTestedMainSha` returns `{ state: 'unknown' }`. The two
     callers then fail closed: this story's gate treats `unknown` as **moved** (re-check), and the main-red
     gate (#xca0u65) grants **no exemption**. A re-check costs one CI cycle, bounded by the per-PR cap in
     step 3; a wrong "tested" costs an untested merge.
   - **A claim can only add re-checks, never remove them, and never stands in for the derived value.** Add a
     one-line step to `we:.github/workflows/ci.yml`, right after checkout, that records `git rev-parse HEAD^1`
     as a check-run annotation or job output. The drain reads it only as a *hint*: when the derived value is
     exact, the effective tested SHA is the **older** (more ancestral on main's first-parent line) of the
     derived value and the claimed one. A forged "current tip" therefore changes nothing; a forged old value
     only causes extra re-checks, which the per-PR cap in step 3 already bounds. A hint that is not a commit
     on main's first-parent line is ignored. **When the derived value is `unknown`, the hint is not used at
     all** (the PR's own job wrote it, so it cannot establish a tested commit by itself): the result stays
     `unknown`.
   Shared helpers live in `we:scripts/lib/tested-main-base.mjs`, which the main-red story (#xca0u65) also
   uses: `readTestedMainSha(run)` (derive exactly, then apply the hint rule; returns `{ state: 'exact', sha }`
   or `{ state: 'unknown', reason }`) and `mainMovedSince(tested, mainTip)`, which returns "moved" for an
   `unknown` input. A run for which no exact SHA can be derived (an older run, a deleted merge ref) counts
   as "moved", the safe direction.
2. **What counts as "main moved".** `mainMovedSince` walks main's first-parent commits in
   `testedMainSha..mainTip`. Main moved when **any** of them is not a drain bookkeeping commit. Drain
   bookkeeping commits (the JIT-numbering commit and the resolve-on-land commit, which land minutes after each
   merge: 469-1029 s, per the #3383 note in `we:scripts/check-standards-rules.mjs`) are recognised **by what
   the commit changes, not by what it says**. A commit is bookkeeping only if **every path in its diff** is
   one the drain itself rewrites (the builder reads the path set from `we:scripts/lane-drain.mjs` and
   `we:scripts/merge-ai-prs.mjs`, for example `we:backlog/` and `we:docs/agent/`, and pins it in one exported
   constant). The subject prefix and author the drain writes are a second, necessary condition, never a
   sufficient one: a subject and author are attacker-influenceable (a squash-merged PR title can copy the
   drain's subject, and agents share one GitHub actor), while the paths a commit changes are read from git
   and not chosen by its message. A commit whose diff touches any other path (`we:scripts/`, `we:.github/`,
   `we:config/`, source) counts as a real move whatever its subject says. **Two limits, stated plainly:** a
   real PR that touches only the drain's rewrite paths and copies the drain's subject and author still reads
   as bookkeeping, and `check:standards` reads some of those paths, so the path set is kept as small as the
   drain's real writes (the builder pins only paths the drain writes, not whole trees it merely reads). And
   a commit whose file list cannot be read in full (the compare API truncates its commit and file lists,
   around 250 commits and 300 files) counts as a real move, never as bookkeeping. Without this exclusion, merge A's own bookkeeping commit lands during B's rebuilt CI run, B
   reads as stale again, and the queue stalls.
3. **Pure predicate** `needsMainMovedRecheck({ policy, moved, testedUnknown, runStartedAt, recheckCount, now })`:
   - `if-older-than-N-min` (default): re-check only when main moved **and** the PR's last green run started
     more than `recheckMaxAgeMin` (30) minutes ago. **Exception:** when the tested main commit is `unknown`
     (step 1), the run's age is not consulted and the PR is re-checked: the age gate exists to trust a fresh
     run whose tested commit is known, and an unknown tested commit gives nothing to trust.
   - `always`: re-check whenever main moved (per step 2).
   - `off`: never re-check (today's behaviour).
   - **Bounded.** A PR already re-checked `RECHECK_MAX_PER_PR` times (module constant, 2) in the last 6 hours
     is **not** re-checked again: it proceeds as `off` would, and the drain records one `recheck-cap-reached`
     event. So a busy main can delay a PR by at most two CI cycles, never stall it indefinitely.
   - **The count lives in state the drain owns, not in the journal.** The policy journal is best-effort and
     write-only audit (`recordPolicyEvent` never throws, so an unwritable or rotated journal silently loses
     events and would reset a journal-derived count to 0 on every pass, which is a rebuild loop). The count
is a durable per-PR record (timestamps of each re-check) in a new JSON state file named `recheck-state` (a runtime file, not a repo path) in
     the same logs directory as the journal (`defaultLogsDir`, story #xcs4nce) but a **separate file** with a
     separate reader and writer (no existing per-PR drain store was found in `we:scripts/merge-ai-prs.mjs`).
     It is keyed `<repo>#<pr>`, written by write-to-temp-then-rename so a crash leaves the old file intact,
     and entries older than the window are dropped on write. **Order matters:** the drain writes the count
     first and rebuilds only if that write succeeded. If the file cannot be read (other than "does not exist
     yet", which is an empty count) or cannot be written, the drain does **not** re-check (it proceeds as
     `off` would) and raises the refusal alert (story #xq4p21a) under the subject `recheck-state`; a clean
     read and write afterwards records `drain-step-ok`. A broken store can never produce an unbounded rebuild
     loop.
4. **Where.** Read the run from the same latest run that `isRequiredCheckGreen` selects
   (`we:scripts/merge-ai-prs.mjs:356-469`). Apply the predicate in the per-PR revalidation just before the
   merge. Re-read main's tip after every merge in the serial loop, so the second PR of a pass sees the first
   PR's merge.
5. **Action.** On a re-check, skip with reason `recheck-main-moved`, record a `recheck-main-moved` event, and
   rebuild the PR onto `origin/main` with `rebaseDropManifest` (falling back to `rebaseDropContent`, as the
   existing path does). That pushes a new head, CI runs on it, and a later pass merges it when green.
   - A real conflict stays skipped for the conflict-fix path.
   - Never touch a `review:*` label or the `ready-to-merge` label.
   - In dry-run mode, print `would re-check` and push nothing.
6. **Kill switch.** The policy value `off` is the kill switch. No new CLI flag.

The engine-tier trust chain covers `we:scripts/merge-ai-prs.mjs` (`we:scripts/lib/gate-config.mjs`), so this
PR escalates to the review committee, as expected.

## MVP

Steps 1 to 5.

## Test plan

- **Capability (RED today, fails before this lands):** `we:scripts/__tests__/merge-ai-prs-recheck-main-moved.test.mjs`:
  - The predicate, per value: `always` re-checks on any move; `off` never; `if-older-than-N-min` with N = 30
    merges a 10-minute-old run and re-checks a 45-minute-old one. A main that did not move never re-checks.
  - **Bookkeeping only:** main's only new commits since the tested SHA are drain bookkeeping commits (a
    JIT-numbering commit, a resolve-on-land commit): no re-check. One real commit among them: re-check.
  - **Forged bookkeeping subject:** a commit with the drain's exact subject prefix and author whose diff
    touches `we:scripts/` (or `we:.github/`) counts as a real move: re-check. The same subject over a diff that
    stays inside the drain's rewrite paths is bookkeeping.
  - **Truncated or unreadable file list:** a main commit with the drain's subject whose file list is
    truncated, or cannot be read, counts as a real move.
  - **Unknown tested commit is never guessed (RED today):**
    `we:scripts/lib/__tests__/tested-main-base.test.mjs` pins that there is no timestamp path. Fixture: main
    has commits M0 (tested), then a commit M1 whose **commit date is older than the run's `created_at` minus
    10 minutes** but which arrived on main **after** the run (a backdated or cherry-picked commit; commit
    dates and arrival order disagree). With the API giving no exact merge-commit parent, `readTestedMainSha`
    returns `{ state: 'unknown' }` (not M1, not M0), `mainMovedSince` returns moved, and the PR is
    re-checked. The same fixture under #xca0u65's exemption is **not exempt**. Also: the merge-commit
    field absent, the call throwing, and a deleted merge ref each give `unknown`. So does a **rebuilt merge
    ref**: the live merge commit's first parent is a newer main than the run tested, or its second parent
    differs from the run's `head_sha`; it is never read as the tested commit. (The 10 minutes in this
    fixture is a fixture value only; no such margin exists in the module.) After the per-PR re-check cap
    is reached, a PR with an `unknown` tested commit proceeds as `off` would; that is intended and bounded,
    not a hole. The module exports no
    fallback margin constant (a test asserts `TESTED_SHA_FALLBACK_MARGIN_MIN` is not exported).
  - **Forged tested-SHA hint:** a run whose job published main's current tip as its tested SHA, while the
    exact derived value is older, is re-checked. A hint older than the derived value makes the effective SHA
    the older one. A hint that is not on main's first-parent line is ignored. **A hint with an `unknown`
    derived value is ignored:** the result stays `unknown` and the PR is re-checked, even when the hint
    names main's current tip.
  - **Commit identity, not clock:** a run rerun after main moved (new `startedAt`, old tested SHA) is
    re-checked. A run queued and started late, but whose tested SHA equals main's tip, is not.
  - **Bounded:** a PR already re-checked twice in the window is not re-checked a third time; one
    `recheck-cap-reached` event is recorded. After the window the count resets.
  - **Bounded with a broken journal:** with the journal path unwritable (every `recordPolicyEvent` a no-op),
    three passes over the same PR still re-check it at most twice, because the count is read from the
    drain's state, not the journal. With the drain's state store unreadable or unwritable, the PR is **not**
    re-checked and the refusal alert path is called once.
  - A run with no derivable tested SHA counts as moved, under every policy value that re-checks (`always`
    and the default `if-older-than-N-min` alike: an `unknown` tested commit is not subject to the age
    threshold, because without a tested commit the run's age proves nothing).
  - Default (no config): behaves as `if-older-than-N-min` with 30.
  - A bad `recheckMaxAgeMin` falls back to 30, through the loader.
  - **Replay of failure mode (2):** PRs A and B are both green against main M0, B's green run started more
    than 30 minutes ago. The pass merges A (main moves to M1). Before this story: B merges untested against
    M1. After it, under the default: B is skipped with `recheck-main-moved`, and `rebaseDropManifest` is
    called with B's head ref. With B's run only 10 minutes old, the default merges B (fresh CI is trusted).
    Under `always`, B is re-checked either way. Under `off`: B merges (the old behaviour is still selectable).
  - The rebuild never edits a `review:*` label or the `ready-to-merge` label. Dry-run pushes nothing.

## Proof plan

1. Before/after on the live queue: run the drain in dry-run JSON mode on current open PRs, with at least two
   ready PRs. **Before:** both shown as `merge`. **After:** the second shown as `would re-check`, naming
   main's tip and the run's `startedAt`.
2. On the next real drain pass with two or more ready PRs: show the second PR's rebuilt head, its new CI run,
   and its later merge (PR numbers and run ids in the PR description or a follow-up comment).

## Follow-ups

- Throughput: under `always`, a pass merges at most one PR per CI cycle (bookkeeping commits no longer count
  as a move, and a PR is re-checked at most twice, so the queue cannot stall). The default
  `if-older-than-N-min` trusts a run younger than 30 minutes. Batching (test several PRs merged together)
  would be a separate story.

## Done when

1. **Executable:** the replay case fails before this lands (B merges) and passes after (B is re-checked).
2. Proof step 1 is pasted in the PR.
