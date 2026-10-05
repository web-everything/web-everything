---
bornAs: xi8vgqq
kind: story
size: 5
parent: "5112"
status: open
blockedBy: ["5113", "5115"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-recheck-main-moved.test.mjs", "we:scripts/lib/tested-main-base.mjs", "we:scripts/lib/__tests__/tested-main-base.test.mjs", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, drain, merge, freshness]
---

# Re-check a green PR before merge when main moved after its checks ran

Before merging, the drain checks whether main moved past the main commit the PR's green `test` run actually
tested (by commit identity, not by when the run started). If it did, the
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
   - **The rule, in one line (operator ruling on this card):** the tested main commit is either established
     **exactly** or it is `unknown`, and `unknown` **refuses**: this gate re-checks, and #5118 grants no
     exemption. Nothing estimates it. The helper may never return a commit it only believes was tested.
   - **A pinned source must be proved to exist before it is relied on.** A probe on 2026-10-04 of a real
     merged PR's `CI` run (`gh api repos/<repo>/actions/runs?head_sha=<head>`) showed `pull_requests` empty and
     no base SHA on the run object, so that field is **not** a usable source. The builder's first step is a
     feasibility proof: find a source, tied to one run and not writable by the PR, that yields the exact
     merge commit, and record a real-run fixture of it (Proof plan step 0). **If no such source passes,
     the story still ships:** `readTestedMainSha` returns `unknown` for every run, so every run is re-checked
     whenever main is not proven contained (below), **whatever the run's age** (step 3 skips the age gate for
     `unknown`), and #5118 never grants an exemption. That is the intended refuse-by-default state, never
     a reason to add a guess.
   - **The one other exact fact: what the run's own head contains.** Let `B = merge-base(head_sha, mainTip)`,
     with `head_sha` the run's own field. `B` is an ancestor of the head, so it is in the tree the run tested,
     whatever main commit the merge was built on: a known-tested floor, read from git, not a date. For an
     `unknown` tested SHA, `mainMovedSince` walks `B..mainTip` instead of `tested..mainTip`, with the same
     bookkeeping rule as step 2: when every commit in it is drain bookkeeping (or it is empty, the head
     already contains the tip), main has **not moved**. So a PR rebuilt by step 5 converges when no pinned
     source exists, and merge A's own later numbering commit does not strand it. This relies on main being
     append-only (branch protection forbids force-push), and an ancestry check that fails, or a commit
     object that is missing, counts as **not contained** (moved). It is the only way an `unknown` run can
     pass, it reads no clock, and it is used by this gate only: #5118 reads `readTestedMainSha`, never
     this containment walk, so for #5118 an `unknown` run is still not exempt.
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
     gate (#5118) grants **no exemption**. A re-check costs one CI cycle, bounded by the per-PR cap in
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
   Shared helpers live in `we:scripts/lib/tested-main-base.mjs`, which the main-red story (#5118) also
   uses: `readTestedMainSha(run)` (derive exactly, then apply the hint rule; returns `{ state: 'exact', sha }`
   or `{ state: 'unknown', reason }`) and `mainMovedSince(tested, mainTip, runHeadSha)`, which returns
   "moved" for an `unknown` input unless the walk from `merge-base(head_sha, mainTip)` to `mainTip` finds
   only bookkeeping (the containment fact above). A run for which no exact SHA can be derived (an older run, a deleted merge ref) counts as
   "moved", the safe direction.
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
3. **Pure predicate** `needsMainMovedRecheck({ policy, moved, testedUnknown, runAgeAnchor, recheckCount, now })`:
   - `if-older-than-N-min` (default): re-check only when main moved **and** the PR's last green run is older
     than `recheckMaxAgeMin` (30) minutes, measured from `runAgeAnchor`. **The anchor is not the run's start
     time.** A rerun resets `run_started_at` but reuses the run's original merge commit, so a clock read from
     it would call a rerun of an old run "fresh" while it still tested the old main (the same rerun trap step 1
     names for the tested commit). `runAgeAnchor` is the **older** (earlier) of the run's `created_at` (set once,
     when the run was first created) and its `run_started_at`, so neither field's rerun behaviour can make a
     run look younger than it is. If either field is missing, unparseable or in the future, the anchor is
     treated as "older than any limit" and the PR is re-checked (the safe direction).
     **Exception:** when the tested main commit is `unknown` (step 1), the run's age is not consulted and the
     PR is re-checked: the age gate exists to trust a fresh run whose tested commit is known, and an unknown
     tested commit gives nothing to trust.
   - `always`: re-check whenever main moved (per step 2).
   - `off`: never re-check (today's behaviour).
   - **Bounded.** A PR already re-checked `RECHECK_MAX_PER_PR` times (module constant, 2) in the last 6 hours
     is **not** re-checked again, and the drain records one `recheck-cap-reached` event. What happens next
     depends on whether the tested commit is known:
     - **Exact tested SHA:** it proceeds as `off` would. The main it tested is known, so the merge is a
       known, bounded risk, never a guess. So a busy main can delay such a PR by at most two CI cycles.
     - **`unknown` tested SHA (and main not contained in the head):** it is **held, never merged**: skipped
       with reason `recheck-unknown-held`, and the refusal alert (story #5115) is raised under the subject
       `recheck-unknown-held`. The cap limits rebuilds; it never turns "unknown" into "tested". The hold
       clears on its own once the window passes (the PR is rebuilt again) or once main stops moving long
       enough for a rebuilt head to contain main's tip.
   - **The count lives in state the drain owns, not in the journal.** The policy journal is best-effort and
     write-only audit (`recordPolicyEvent` never throws, so an unwritable or rotated journal silently loses
     events and would reset a journal-derived count to 0 on every pass, which is a rebuild loop). The count
is a durable per-PR record (timestamps of each re-check) in a new JSON state file named `recheck-state` (a runtime file, not a repo path) in
     the same logs directory as the journal (`defaultLogsDir`, story #5113) but a **separate file** with a
     separate reader and writer (no existing per-PR drain store was found in `we:scripts/merge-ai-prs.mjs`).
     It is keyed `<repo>#<pr>`, written by write-to-temp-then-rename so a crash leaves the old file intact,
     and entries older than the window are dropped on write. **Order matters:** the drain writes the count
     first and rebuilds only if that write succeeded. If the file cannot be read (other than "does not exist
     yet", which is an empty count) or cannot be written, the drain does **not** re-check and raises the
     refusal alert (story #5115) under the subject `recheck-state`. A PR with an exact tested SHA then
     proceeds as `off` would; a PR with an `unknown` tested SHA that main moved past is **held** (skipped with
     `recheck-unknown-held`), never merged, exactly as at the cap. A clean
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
    merges a 10-minute-old run whose tested SHA is exact and re-checks a 45-minute-old one. A main that did not move never re-checks.
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
    re-checked. The same fixture under #5118's exemption is **not exempt**. Also: the merge-commit
    field absent, the call throwing, and a deleted merge ref each give `unknown`. So does a **rebuilt merge
    ref**: the live merge commit's first parent is a newer main than the run tested, or its second parent
    differs from the run's `head_sha`; it is never read as the tested commit. (The 10 minutes in this
    fixture is a fixture value only; no such margin exists in the module.) The module exports no
    fallback margin constant (a test asserts `TESTED_SHA_FALLBACK_MARGIN_MIN` is not exported).
  - **Cap reached with an unknown tested commit (RED today):** a PR already re-checked twice in the window,
    whose tested SHA is `unknown` and that fails the containment walk (step 1), is **not merged**: it is
    skipped with `recheck-unknown-held` and the refusal alert path is called once. The same PR with an
    **exact** tested SHA proceeds as `off` would. With every run `unknown` (pinned source stubbed out), no
    PR ever merges against a main its head does not contain.
  - **Default policy, a fresh run with an unknown tested commit (RED today):** under the default
    `if-older-than-N-min` with no config, a run 10 minutes old (well inside 30), tested SHA `unknown`, main
    moved to M1 by a commit that is not bookkeeping, M1 not contained in the run's `head_sha`: the PR is
    **re-checked**, not merged. The age gate is not consulted for `unknown`.
  - **Containment is the only pass for unknown:** the same fresh `unknown` run whose `head_sha` has main's
    tip as an ancestor (a PR just rebuilt onto main) is not re-checked. So is one whose head contains M1
    while main has since gained only a drain numbering commit M2 (`merge-base(head_sha, mainTip)` = M1, and
    M1..M2 is bookkeeping). A head that contains an older main commit, with a real commit after it on main,
    is re-checked. An ancestry call that throws, or a missing commit object, is re-checked.
  - **Refuse when not exact (RED today):** a test over a table of inputs (every shape the API can give:
    missing field, malformed SHA, an extra parent, a second parent that is not the run's `head_sha`, a
    first parent that is not on main's first-parent line, a call error, a timeout) asserts the **only** two
    outcomes are `{ state: 'exact', sha }` where `sha` was read from a pinned source, and `{ state:
    'unknown' }`. A property-style assertion walks the helper's source and fixtures to check no code path
    reads a commit date or run timestamp to choose a SHA. With the pinned source stubbed out entirely, every
    input is `unknown` and the drain re-checks (the always-refuse state).
  - **Forged tested-SHA hint:** a run whose job published main's current tip as its tested SHA, while the
    exact derived value is older, is re-checked. A hint older than the derived value makes the effective SHA
    the older one. A hint that is not on main's first-parent line is ignored. **A hint with an `unknown`
    derived value is ignored:** the result stays `unknown` and the PR is re-checked, even when the hint
    names main's current tip.
  - **Commit identity, not clock:** a run rerun after main moved (new `run_started_at`, old tested SHA) is
    re-checked. A run queued and started late, but whose tested SHA equals main's tip, is not. **This case is
    tested once per policy value, including the default** (the rule above is only as good as its test under
    each value), because the default is the one that reads a clock:
    - `always`: the rerun is re-checked (main moved).
    - **`if-older-than-N-min` (the default), the rerun case:** tested M0, `created_at` 3 hours ago,
      `run_started_at` reset to 5 minutes ago by a rerun, main now at M1. The PR **is** re-checked, because the
      age anchor is the older `created_at`, not the reset start time. With a predicate that read
      `run_started_at` this case merges B untested against M1, so it fails against that implementation.
    - Default, a genuinely fresh run: `created_at` and `run_started_at` both 10 minutes ago, tested M0, main at
      M1 by a commit that is not bookkeeping: not re-checked (fresh CI is trusted, as the replay below says).
    - Default, a bad anchor input, one case each: `created_at` missing; `run_started_at` missing; either one
      unparseable; either one in the future: each is re-checked (the anchor reads as "older than any limit").
    - `off`: the rerun is not re-checked (today's behaviour).
    - **Wiring:** the caller (the drain) passes the anchor computed from both fields, and a test asserts the
      predicate is never handed `run_started_at` alone.
  - **Bounded:** a PR (exact tested SHA) already re-checked twice in the window is not re-checked a third
    time; one `recheck-cap-reached` event is recorded. After the window the count resets.
  - **Bounded with a broken journal:** with the journal path unwritable (every `recordPolicyEvent` a no-op),
    three passes over the same PR still re-check it at most twice, because the count is read from the
    drain's state, not the journal. With the drain's state store unreadable or unwritable, the PR is **not**
    re-checked and the refusal alert path is called once. **Store unreadable or unwritable, with an `unknown`
    tested commit (RED today):** the PR is held with `recheck-unknown-held`, **not merged**.
  - A run with no derivable tested SHA counts as moved (unless it passes the containment walk, step 1), under every
    policy value that re-checks (`always`
    and the default `if-older-than-N-min` alike: an `unknown` tested commit is not subject to the age
    threshold, because without a tested commit the run's age proves nothing).
  - Default (no config): behaves as `if-older-than-N-min` with 30.
  - A bad `recheckMaxAgeMin` falls back to 30, through the loader.
  - **Replay of failure mode (2):** PRs A and B are both green against main M0, B's green run is older
    than 30 minutes by its age anchor (even if a rerun reset its start time). The pass merges A (main moves to M1). Before this story: B merges untested against
    M1. After it, under the default: B is skipped with `recheck-main-moved`, and `rebaseDropManifest` is
    called with B's head ref. With B's run only 10 minutes old and its tested SHA exact, the default merges
    B (fresh CI is trusted); with it `unknown`, B is re-checked.
    Under `always`, B is re-checked either way. Under `off`: B merges (the old behaviour is still selectable).
  - The rebuild never edits a `review:*` label or the `ready-to-merge` label. Dry-run pushes nothing.

## Proof plan

0. **Feasibility, before any other step.** Against one real merged PR's `CI` run, call `readTestedMainSha`
   un-injected and paste its result. Either it returns `{ state: 'exact', sha }` and the sha equals the first
   parent of the merge commit that run checked out (shown by the run's own checkout log line), or it returns
   `{ state: 'unknown' }` and the PR says plainly that no pinned source was found, so the shipped behaviour is
   always-refuse. A fixture of the real response is committed beside `we:scripts/lib/__tests__/tested-main-base.test.mjs`. A story whose
   only evidence is injected readers has not proved the exact path is reachable.
1. Before/after on the live queue: run the drain in dry-run JSON mode on current open PRs, with at least two
   ready PRs. **Before:** both shown as `merge`. **After:** the second shown as `would re-check`, naming
   main's tip and the run's age anchor (the older of `created_at` and `run_started_at`).
2. On the next real drain pass with two or more ready PRs: show the second PR's rebuilt head, its new CI run,
   and its later merge (PR numbers and run ids in the PR description or a follow-up comment).

## Follow-ups

- Throughput: under `always`, a pass merges at most one PR per CI cycle (bookkeeping commits no longer count
  as a move, and a PR with an exact tested SHA is re-checked at most twice). The default
  `if-older-than-N-min` trusts a run younger than 30 minutes **only when its tested SHA is exact**. A PR
  whose tested SHA is `unknown` can be held at the cap on a busy main; that hold is visible (alert) and
  self-clearing, and is the price of never guessing. Batching (test several PRs merged together) would be a
  separate story.

## Done when

1. **Executable:** the replay case fails before this lands (B merges) and passes after (B is re-checked).
2. Proof steps 0 and 1 are pasted in the PR.
3. **Executable (the operator's no-guess ruling):** the "Unknown tested commit is never guessed" and "Refuse
   when not exact" cases in `we:scripts/lib/__tests__/tested-main-base.test.mjs`, and the "Cap reached with
   an unknown tested commit" and "Default policy, a fresh run with an unknown tested commit" cases in
   `we:scripts/__tests__/merge-ai-prs-recheck-main-moved.test.mjs`, fail before this lands and pass after.
   Under any policy value other than the `off` kill switch (itself a human-gated config edit, story
   #5113), no path (age gate, re-check cap, broken re-check store, hint, or #5118 exemption) merges a
   PR whose tested main is `unknown` and that main moved past since `merge-base(head_sha, mainTip)`.
