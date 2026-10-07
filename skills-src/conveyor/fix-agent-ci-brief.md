# Conveyor CI-heal fix-agent brief (template) — merge + repair a green-at-open PR gone RED / BEHIND, NEVER touch the review gate (#2666)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill (#2613) instantiates it when a
> conveyor-launched PR that was **green at open** later goes **red on a required check** or **BEHIND + parked** —
> a CI regression, NOT a `review:changes` bounce. It fills the `{{PLACEHOLDERS}}` below and passes the result as
> the prompt for **one background CI-heal agent** spawned into that PR's lane. One agent = one red/BEHIND PR = one
> merge + repair = one re-push. The agent does the JUDGMENT work (diagnose the failing check, repair it); every
> script-decidable step around it is a script it shells, per
> [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)
> (#2607).

> **Why this exists.** The conveyor's merge watcher (`pr-watch.mjs`) resolves a launched PR only on a TERMINAL
> signal (merged / parked / closed / timeout) and only auto-repairs a `review:changes` bounce (#2630). A PR that
> was **green at pr-land** but later goes **red on a required check** — most often because `main` advanced under it
> and its `test` job broke against the new main (a flake is the other cause) — silently stalls: the delivery agent
> has long exited (one agent = one item = one PR), and the drain **skips a red-CI PR**. #2183 rebuilds a BEHIND but
> **landable** PR, but a PR **parked** `review:human` / `review:pending` is NOT landable, so #2183 never fires for
> it. This brief is the **auto CI-heal** path: reconstitute the PR's lane, merge the live PR base into the lane, repair the
> failing check, re-push — **repairing ONLY CI, never the review label**. This is the CI-axis sibling of
> [`fix-agent-brief.md`](fix-agent-brief.md) (the `review:changes` repair loop); the two share the reuse-the-ref,
> repair-only, re-push shape — the ONE difference is that the review-changes agent RE-ARMS the review and this one
> **must not go near it**.

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number the PR delivers — e.g. `2638` |
| `{{PR_NUM}}` | the red/BEHIND PR's number — e.g. `743` |
| `{{LANE_REF}}` | the PR's head ref — `lane/{{ITEM_NUM}}-<slug>` (`gh pr view {{PR_NUM}} --json headRefName`) |
| `{{LANE}}` | a FREE lane id the conveyor assigned this heal (a fresh clone; the heal is reconstituted from `{{LANE_REF}}`, not the original lease) |
| `{{SESSION_SLUG}}` | a stable per-heal session slug, e.g. `ci-heal-{{PR_NUM}}` (ties `acquire`↔`release`) |
| `{{SCOPE}}` | the item's `scope:` frontmatter, repo-qualified & comma-joined (same as the build's scope) |
| `{{REASON}}` | why it fired — `red-ci` (a required check went red) or `behind` (BEHIND + parked) — for the durable comment |
| `{{REPO}}` | the target repo's gh slug (e.g. `web-everything/web-everything`) — every `--repo=` flag below |
| `{{LANE_REPO}}` | what `lane-pool.mjs --repo=` itself expects — an absolute checkout path always (equal to `{{WE_ROOT}}` for WE, a sibling's own checkout otherwise; landing-freeze fix — was `.` for WE, which broke from this dispatch's own scratch cwd) |
| `{{GATE_COMMAND}}` | informational only — the sibling-repo-aware synchronous `run` form (`gateFor(...)`, `we:scripts/lib/repo-profile.mjs`); a dispatched agent does NOT run it (the guard denies it) and uses `verify-lane.mjs request` / `check` in step 4 |
| `{{WE_ROOT}}` | the absolute WE checkout that owns every tool this brief runs (`ci-heal-mark.mjs`, `lane-pool.mjs`, …) |
| `{{ATTRIBUTION}}` | the commit-title reference — `WE #{{ITEM_NUM}}`-shaped for WE today, `PR #{{PR_NUM}}` for an item-less heal |

> **`{{LIKE_THIS}}`** are **conveyor-injected** (the table above). **`<like-this>`** are **agent-runtime values**
> you produce as you work (the `<msgfile>` you write). Do not expect the conveyor to fill a `<...>`; that's your
> job at the moment it's used.

---

## Your job (one sentence)

Reconstitute the PR's work in a lane clone reset to its pushed ref, **merge the live PR base into the lane**, **diagnose and
repair the failing required check** (repair only the CI break — do NOT touch the item's substance beyond what the
check needs), commit it and hand the verify wait to the harness (which **re-pushes that commit to the same `lane/*`
ref** on green and resumes you), **post the durable CI-heal comment**,
then **EXIT WITHOUT LANDING THE PR** — and **NEVER touch the review label** (`review:human` / `review:pending` /
`review:changes` stay exactly as they were; only CI is repaired).

## If you escalate — WHY a second command beyond the completion record (read once, before you need it)

we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — LIVE INCIDENT, PR #2783 (web-everything/web-everything):
three ci-heal sessions in one evening each escalated for the IDENTICAL reason on the IDENTICAL head. The
`completion-cli.mjs report --outcome=escalated-*` calls throughout this arc are session bookkeeping (they key off
`{{SESSION_SLUG}}`, which is the SAME `ci-heal-{{PR_NUM}}` slug every future dispatch for this PR reuses — a NEW
session's own `started` report overwrites that record, per that CLI's own docblock, so nothing survives across
dispatch GENERATIONS). They tell the reconciler "this session is no longer live"; they do NOT tell it "the next
session would just re-ask the same already-answered question" — so every tick kept re-dispatching a fresh heal.

`ci-heal-escalation-mark.mjs` closes that gap with a comment ON THE PR ITSELF, keyed to the exact head it was
posted against — durable across dispatch generations, and auto-re-arming the instant a new push moves the head
(no human needs to clear anything for that to happen). Every escalation exit below that names a genuine "a person
must look at this, and it will look identical on a retry" fact (lane ref gone, conflict with main, not a CI
break) now posts BOTH the completion record (session bookkeeping) and this marker (PR-durable, head-scoped) — in
that order. `blocked-on-infra` and `gate-red` are deliberately NOT part of this: both are meant to retry (a
transient tool/permission denial clears; a different repair attempt might pass the gate a genuinely-broken one
did not), so neither gets a marker that would stop that retry.

## The arc — one command per transition

### 0. Report `started` — BEFORE anything else (#3436, #4075/xg7m2wq)

The one durable trace that a CI-heal of PR #{{PR_NUM}} was ever dispatched, written before step 1 can fail for
any reason — a lane-pool outage, a crash, a refused effect. Without this a session that dies here is
indistinguishable from one never dispatched at all (`we:backlog/3436-*.md`) — and, live-caught on PR #2724
(2026-09-26), without a matching `report --status=done` at whichever exit this session actually reaches, a
FINISHED ci-heal keeps counting as a live holder of its own PR forever, exactly the way `fix-agent-brief.md`'s
own step 0/step-per-exit shape already prevents for a `review:changes` repair:

```bash
# #4269 — capture the head THIS SESSION IS ABOUT TO DIAGNOSE, ONCE, before anything else — every escalation
# exit below uses THIS captured value, never a fresh `gh pr view` read at escalation time. Reading the head
# live at escalation time (after diagnosis, possibly minutes later) can return a head a CONCURRENT push swapped
# in mid-session — a revision this session never actually examined — and permanently stamp the escalation
# marker against it, silently suppressing healing on a head nobody ever diagnosed.
EXAMINED_HEAD="$(gh pr view {{PR_NUM}} --repo {{REPO}} --json headRefOid --jq .headRefOid)"
CI_AUTH_ARGS=() # populated only for a diagnosed CI authentication failure

node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --kind=ci-heal --pr={{PR_NUM}} --item={{ITEM_NUM}} --status=started
```

### 0b. Take the fix claim — `fix-begin` (the fix procedure, operator-approved 2026-09-27; draft-only-on-withdrawal, `we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`)

One author changes a PR's branch at a time — a CI-heal included. Take the PR's fix claim before anything else:

```bash
node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-begin {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}} \
  --why="conveyor ci-heal: {{REASON}}"
```

**A ci-heal is a normal repair loop, so this stays READY by default — never draft.** It labels the PR
`review-status:fixing` and refuses pushes to its branch by anyone but you; the claim itself is the lock. If it
is **refused** (exit 3), another fixer owns the PR right now: report `--status=done --outcome=not-applicable`
and RETURN `#{{ITEM_NUM}} → ci-heal not-applicable (fix claim held by <holder>)`. **Every exit from here on
releases the claim with `fix-end`** (the blocks below carry the line). A plain (never-drafted) claim leaves the
PR ready with nothing further owed; `fix-end` does not rely on the draft-first promotion for it. (A ci-heal
does not itself add `--draft` — that pair of reasons, `scope-change`/`withdrawn`, only ever applies to a
review-findings fix that discovers one mid-review; see the ordinary fix brief's step 0b.)

### 1. Reconstitute the PR's work in a lane clone (reuse the ref — never rebuild from scratch)

The work is intact on the `{{LANE_REF}}` ref (the pushed PR head). Acquire a free lane reset **to that ref**, so
your clone opens at the exact HEAD that was pushed:

> **You started in a scratch directory, not a checkout** — and it holds nothing of `scripts/`, which is why
> `{{WE_ROOT}}` qualifies every tool call in this brief. Never write a file there by a relative path, and never
> write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched you): either one left dirty by a stray
> write is how a dispatcher's own clone gets stuck refusing every future dispatch as stale (#4174).

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --repo={{LANE_REPO}} --lane={{LANE}} --purpose=conveyor-ci-heal \
  --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}) && cd "$LANE"
```

- `--base={{LANE_REF}}` lands the clone on the pushed lane tip, so you **reuse the built work** — you are healing a
  diff's CI, not redoing the item. If `--base` fails to resolve (the ref was deleted / the PR was force-closed),
  report the completion record and stop and report `#{{ITEM_NUM}} → ci-heal not-applicable (lane ref gone)`:
  ```bash
  node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=not-applicable
  node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
  ```
  A gone ref will still be gone on the very next tick's re-dispatch — post the durable, head-scoped escalation
  marker too (we:backlog/heal-wait-for-rerun; see the callout right after this arc for the FULL outcome-choice
  guidance) so the conveyor stops re-dispatching a heal that will only fail identically again, until a human
  intervenes or a new push resolves it:
  ```bash
  node "{{WE_ROOT}}/scripts/conveyor/ci-heal-escalation-mark.mjs" {{PR_NUM}} --repo={{REPO}} \
    --head="$EXAMINED_HEAD" \
    --outcome=needs-human --reason="lane ref gone — {{LANE_REF}} no longer resolves"
  ```
- **`cd "$LANE"` just left WE's own checkout.** `{{LANE_REF}}` can belong to any constellation repo, so from
  here on your cwd may hold no `scripts/` directory at all — every remaining tool call in this brief is
  qualified with `{{WE_ROOT}}` for exactly that reason. Never drop the `{{WE_ROOT}}/` qualifier for a bare
  relative path.
- Do **NOT** re-`claim` the item — it is already `active` (or `resolved`) from the build; a re-claim would race.

### 2. Merge the live PR base (the usual root cause — `main` advanced under the branch)

**This is the ONE sanctioned catch-up with `main` for this whole run (#4297), placed FIRST rather than
immediately before step 4's gate** — unlike the generic build/fix briefs, diagnosing a "behind" CI failure
needs a current base to diagnose against, so front-loading it is the deliberate, once-only equivalent of their
right-before-the-gate placement, not an exception to it.

**Do NOT merge a second time in this same session**, even if `main` advances again while you are still
diagnosing/repairing (step 3) or before you re-push (step 6) — a clean step-2 merge leaves no working-tree
conflict for a later `main` move to reopen, so nothing forces a second merge; merging again would only
restart the "catch-up" this step already finished once. If `main` moving again genuinely matters, that is the
next tick's fresh ci-heal dispatch's job, not this run's — finish this pass on the base you already have.

Read the live base even for a stacked PR. Preserve its commit identities with a real merge; never replay
`merge-base..main` via cherry-pick or rebuild upstream commits. After resolving a conflict, complete the merge
and rerun the ancestry check against the saved `BASE_SHA` before proceeding. This proves the two-dot and
three-dot diffs agree against that fetched base; a later base advance requires a fresh comparison.

```bash
BASE_REF=$(gh pr view {{PR_NUM}} --repo {{REPO}} --json baseRefName --jq .baseRefName)
test -n "$BASE_REF" || exit 1
git fetch origin "$BASE_REF" || exit 1
BASE_SHA=$(git rev-parse FETCH_HEAD) || exit 1
git merge --no-edit "$BASE_SHA" || exit 1
git merge-base --is-ancestor "$BASE_SHA" HEAD || exit 1
```

To take one side of a conflicted file, or union both, use ONLY
`node {{WE_ROOT}}/scripts/conveyor/resolve-conflict.mjs --dir=<your lane path> --file=<path> --take=ours|theirs|union`
(unquoted script path, exactly this shape; pre-allowed in this session's settings).
NEVER use `git checkout --ours/--theirs`, `git checkout -- <file>`, `git restore`, or `git reset` on a file:
the auto-mode classifier denies those as "[Irreversible Local Destruction]" (live: fix-3964, PR #3964).
Hand-merged hunks still use the Edit tool, then `git add`.

Resolve any conflict the `/finish` way: **regenerate derived / generated artifacts** rather than hand-merging them,
and **take-main for coordination JSON** (`claims.json`, registries). If it is a genuine same-line CODE overlap you
cannot safely resolve, `git merge --abort` (leave the PR as it is — do NOT force-push a bad merge), report the
completion record, and stop and report `#{{ITEM_NUM}} → ci-heal escalated (conflict with main)`. A clean merge
alone often fixes a BEHIND `test` failure.

```bash
git merge --abort
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-conflict
node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
node "{{WE_ROOT}}/scripts/conveyor/ci-heal-escalation-mark.mjs" {{PR_NUM}} --repo={{REPO}} \
  --head="$EXAMINED_HEAD" --outcome=needs-human --reason="conflict with main during merge"
```

(`git merge --abort` FIRST, so you never leave a half-merged tree behind. `--head` is ALWAYS `$EXAMINED_HEAD`
— the PR's PUBLISHED head, captured ONCE at step 0 before diagnosis began — never `git rev-parse HEAD` (after a
clean merge that you have not pushed, the local `HEAD` is a commit GitHub never saw, the marker would never
match `pr.headRefOid`, and the next tick would dispatch the same heal again) and never a FRESH `gh pr view` read
taken here, at escalation time: a concurrent push between step 0 and this exit would hand you a head this
session never actually diagnosed, and stamping the marker against it would silently suppress healing on a
revision nobody examined (#4269). See the callout right after this arc for what the marker does and why.)

### 3. Diagnose + repair the failing required check (repair ONLY the CI break)

Read what actually failed, then make the **smallest** change that turns it green:

```bash
gh pr checks {{PR_NUM}} --repo {{REPO}}          # which required check is red
gh run view <run-id> --log-failed --repo {{REPO}} # the failing step's log (optional, for a non-obvious break)
```

- For **CI authentication failures** (for example Bad credentials at Checkout FUI), capture the diagnosed
  `AUTH_RUN` and `AUTH_ATTEMPT` from that run's metadata, keeping the original `$EXAMINED_HEAD`.
  When operator credential replacement is required, prepare read-only enrichment for the existing
  **needs-human** exit below:
  ```bash
  CI_AUTH_ARGS=(--run="$AUTH_RUN" --attempt="$AUTH_ATTEMPT")
  ```
  That exit passes this array to the marker alongside the captured head. The marker identifies the failed
  step's reference and consuming repository; a 401 does not establish expiry. Unresolved ownership or
  unavailable logs must stay unresolved; never guess a rotation target from the checkout destination.
  The displayed repository-scoped rotation command prompts the operator for a replacement; the healer never executes it.

- If a clean merge already fixes it (the failure was purely BEHIND against the new main), no code change is
  needed — proceed to the gate.
- If a real break remains (a flake, or a genuine interaction with what landed on `main`), repair **only** that, in
  `$LANE`, on the lane's **current branch** (its local `main` — do **NOT** `git checkout -b`; the single-branch
  hook blocks branch creation even in a lane clone). Keep scope within `{{SCOPE}}`. **Do NOT weaken or delete a
  test to go green**, and do NOT fold in unrelated work.
- **Before escalating, check for a metadata-only fix.** Some required-check-adjacent gates read the PR's own
  DESCRIPTION rather than its diff — the soak-replay-gate's waiver (`soak-waiver: <reason>` in the PR body,
  `we:scripts/lib/soak-replay-gate.mjs`) is the current example. If `gh pr checks`'s failing-check summary (or
  its log) says it is reading the PR body, not the code, and adding a plain `soak-waiver: <reason>` line
  genuinely applies (the change really IS soak-safe — never invent a reason that is not true), add it and
  continue instead of escalating (the skip rule right after the fence says whether step 4 is needed):
  ```bash
  gh pr view {{PR_NUM}} --repo {{REPO}} --json body --jq .body > <bodyfile>
  printf '\n\nsoak-waiver: <the genuine reason>\n' >> <bodyfile>
  node "{{WE_ROOT}}/scripts/pr-body-edit.mjs" --pr={{PR_NUM}} --repo={{REPO}} --body-file=<bodyfile>
  ```
  (never a raw `gh pr edit --body` — it drops the PR's own authorship stamp; see that script's own header.)
  **Metadata-only skip (#34).** When `git diff --quiet "$EXAMINED_HEAD" HEAD` exits 0 (the tree is byte-identical
  to the examined head — no commit and no merge), skip steps 4-6 entirely: no `verify-lane.mjs request`. Re-run the
  failed check on the same commit (`gh run rerun <failed-run-id> --failed`), then go straight to step 7 with
  `--outcome=healed`. A clean merge of main or any code edit changes the tree, so it is NOT metadata-only and
  still takes the gate in step 4.
- If the required check is red for a reason that is NOT a CI/merge break and NOT a metadata fix — do **NOT**
  guess which of the three outcomes below applies without checking; picking the wrong one either hides a real
  defect from the operator, wastes their attention on tooling that already has a fix in flight, or (we:backlog/
  fix-review-ciheal-deadlock, LIVE DEADLOCK 2026-09-28/29, PR #2878) silently blocks the PR's own review forever:
  - **`not-a-ci-break` — check this FIRST, before reaching for `needs-human`:** every check `gh pr checks`
    actually lists as a REQUIRED status check (`test`/`smoke`/`daemon-soak`/`soak-replay-gate` — confirm live via
    `gh api repos/{{REPO}}/branches/main/protection --jq .required_status_checks.contexts`, never assume the
    list from memory) is green on `$EXAMINED_HEAD`, and the ONLY red is a review-gate-shaped check
    (`review-gate` itself, or one that only ever reflects the `review:pending`/`review:human`/`review:changes`
    label) — by design, not a defect. This PR did nothing wrong and there is no "system fix" to wait on either:
    it is owed its ORDINARY REVIEW, right now, not another ci-heal attempt:
    ```bash
    node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-needs-human
    node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
    node "{{WE_ROOT}}/scripts/conveyor/ci-heal-escalation-mark.mjs" {{PR_NUM}} --repo={{REPO}} \
      --head="$EXAMINED_HEAD" --outcome=not-a-ci-break --reason="not a CI break — every required check is green; only <name the gate check> is red, held by the review label"
    ```
    Then report `#{{ITEM_NUM}} → ci-heal stood down (not a CI break — owed a review, not a heal)`. This is a
    STRUCTURED signal, not prose: `reconcile-core.mjs`'s escalation refusal reads this exact outcome as "dispatch
    the review this PR was always owed, in parallel" — unlike `needs-human` below, it never durably blocks
    review dispatch.
  - **`needs-human`** — operator credential replacement is required, the diff itself is genuinely wrong and needs a design call, or you are simply unsure
    (never for the review-gate-only case above — that is ALWAYS `not-a-ci-break`, never this). Report and stop:
    ```bash
    node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-needs-human
    node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
    node "{{WE_ROOT}}/scripts/conveyor/ci-heal-escalation-mark.mjs" {{PR_NUM}} --repo={{REPO}} \
      --head="$EXAMINED_HEAD" --outcome=needs-human "${CI_AUTH_ARGS[@]}" --reason="<name the actual finding>"
    ```
    Then report `#{{ITEM_NUM}} → ci-heal escalated (needs human)`. The review gate (if any) still
    owes a human verdict; a human handles it via `/finish`.
  - **`waiting-on-system-fix` — narrow, and ONLY when BOTH hold:** (1) the red is caused by the CI TOOLING/GATE
    ITSELF, not this PR's own diff (the SAME advisory check misbehaving the SAME way on more than one unrelated
    PR is the tell), AND (2) a system-level fix for that exact tooling bug is ALREADY OPEN (e.g. `#2784` fixed
    the soak-replay-gate's own false-red; if you hit that identical shape again before #2784 has landed, use
    this outcome with `--system-fix=2784`). This PR did nothing wrong and does not need the operator's attention:
    ```bash
    node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-needs-human
    node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
    node "{{WE_ROOT}}/scripts/conveyor/ci-heal-escalation-mark.mjs" {{PR_NUM}} --repo={{REPO}} \
      --head="$EXAMINED_HEAD" --outcome=waiting-on-system-fix --system-fix=<n> \
      --reason="<name the tooling bug and the PR fixing it>"
    ```
    Then report `#{{ITEM_NUM}} → ci-heal waiting on system fix #<n> (PR #{{PR_NUM}} did nothing wrong)`.

**If applying the fix is denied by a permission or tool-use guard**, report
`blocked-on-permission` with `--denied="<the exact denied command, one line>"`.
This is a product permission wall, not a judgment call: do not stand down or retry the denied command.
The reconciler surfaces it immediately and holds retries for 60 minutes. Keep `blocked-on-infra`
for outages and rate limits (omit `--denied` for those).

```bash
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=blocked-on-permission --denied="<the exact denied command, one line>"
node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
```

Then report `#{{ITEM_NUM}} → blocked-on-permission (tool/permission denial applying an otherwise-clear CI heal on PR
#{{PR_NUM}})` and exit — do not retry the same denied action yourself in a loop.

**If a genuine code repair is needed, build-brief discipline still applies** (statute:
[we:docs/agent/platform-decisions.md#build-brief-discipline](../../../docs/agent/platform-decisions.md#build-brief-discipline),
#2819): name the concrete failure shape rather than a narrow guess, and never describe the heal comment (step 7)
as "closes"/"fixes" the item itself — it heals CI on an already-open PR, it does not touch the review verdict.

### 4. Run the gate GREEN (the item's own locus gate)

**The harness owns the wait, not you (#5137).** The gate verifies a COMMIT and the harness pushes exactly that
commit, so first finish step 5's self-review and make step 6's commit (the step-2 merge commit alone counts when
the merge healed it) — but NOT its push. Then hand the wait over:

```bash
node {{WE_ROOT}}/scripts/verify-lane.mjs request --repo=.                        # returns almost instantly — nothing has run yet
node {{WE_ROOT}}/scripts/conveyor/await-verify.mjs mark --repo={{REPO}} --pr={{PR_NUM}} --who={{SESSION_SLUG}} --ref={{LANE_REF}} --kind=ci-heal --attempt=1
```

Then **end your turn**: reply with one line (`awaiting verify for <sha>`) and stop. Never `check --wait`, never
`sleep`, never `run_in_background`, never read output files in a loop (#x36vidg), never `reset` or re-`request`
yourself. `mark` refuses a dirty tree or a sha that is not HEAD — commit first. The fix daemon reads the verdict
every tick and resumes THIS session with a message that starts `[harness verify verdict — #5137]`.

A dispatched agent cannot run the gate itself: `we:scripts/guard-bash.mjs` denies any `verify-lane.mjs` invocation
except `request` / `check` / `reset` (#3105) — including a bare `run --repo=.` and `run` wrapped in
`heavy-admission.mjs`. Write the script path **unquoted** (the guard needs whitespace right after `.mjs`; a
quoted path is denied). Do not run `verify-lane.mjs run` here; `request` stamps a marker the verify runner
(`we:scripts/conveyor/verify-dispatch.mjs`) picks up and settles with the same diff-selected gate.

The harness acts on the same verdict `verify-lane.mjs check` prints — the **`check` output**, never the `request`
acknowledgement — and the resume message tells you which branch you are on:
`green` → the harness has already pushed your exact sha to `{{LANE_REF}}`; continue at step 7's CI-heal comment
and never push `{{LANE_REF}}` yourself. `red` (exit 2) → the failing tests are in the message: repair, commit,
`request`, `mark` again with `--attempt=<n+1>`, and end your turn; on the third red the message tells you to take
the gate-red hard stop below. A red the gate classifies as load-only → the message tells you to take the load-flake
exit below. `infrastructure-failure` or no verdict → the harness re-requests on its own; after repeated failures
the message tells you to report the stalled request with the blocked-on-infra exit (the signal/ceiling evidence,
without claiming a test failure). A moved or dirty lane → re-commit, `request`, `mark` again.
Other statuses follow [we:skills-src/conveyor/delivery-agent-brief.md](delivery-agent-brief.md).

After the harness pushes, do NOT wait for the new CI run to go green (no `gh pr checks --watch`, no `sleep` loop on
`gh pr checks`/`statusCheckRollup`) — the ci-heal tally comment is your last write; report and exit.

If the heal also touches a WE-side file (docs, the backlog item itself, WE-side glue) — i.e. `{{SCOPE}}` names
anything outside `{{REPO}}` — additionally run `npm run check:standards` from `{{WE_ROOT}}` before step 4's `request`:
the gate is `{{REPO}}`'s own gate and does not check WE's cross-repo invariants. For WE itself
(`{{REPO}}` == WE), the gate already includes WE's own check:standards (scoped to your diff), so this is
a no-op today.

**The gate is the diff-selected gate** (`verify-lane.mjs`, xpnhz4o): it runs **only the tests your
diff reaches** (`vitest related` on the files changed vs `origin/main`, working tree included, plus the tests that
name a changed file) and a check:standards scoped to those files. Shared helpers use the graph and reference discovery. Unknown, unsafe or oversized selections
return `selection-required`; inspect the scope and supply an explicit affected-test gate, or report the blocker. In that blocked case `request --gate=…` accepts only an
affected-test shape — `&&`-joined `npx vitest related <files…> --run` / `vitest run <files…>` (only the `--run`/`--bail`
flags: never `--passWithNoTests`, `--config`, `--reporter`, `-t`…) / `npm run test:unit` / `npm test` (no arguments) /
`npm run check:standards` segments, no `||`, `;`, `|` or redirection — and refuses anything else (`gate-refused`; a refusal
at run time leaves a red marker).
A default local selection never expands into the full suite. **Never run the full suite yourself**
(`npm run test:unit`, `npm test`, a bare `vitest run`): the verify runner runs the same gate for you, CI runs it
anyway, and the Bash guard denies it.

To debug one or two tests, run `npm run test:unit -- <file(s)>` (≤5 files, 8-minute cap); it uses the fast lane. Run the full verify (request + mark + end turn, per the await flow in step 4) once before the harness pushes — never push yourself.

**Load-flake exception.** When verify is red ONLY on failures in files your heal did not touch, and each of those files passes when run alone (`node {{WE_ROOT}}/scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>`), save and push the heal to `{{LANE_REF}}-heal-{{PR_NUM}}-alt`, then use the load-flake exit instead of the gate-red exit below. Pass the PR's FULL 40-character head sha (`git rev-parse origin/<head ref>`). Only `web-everything/web-everything` has a reverify worker; for any other repo use the gate-red exit below.

```bash
node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs" {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}} --reason=load-flake --head=<pr-head-sha> --alt=<saved-alt-branch> --alt-sha=<saved-sha>
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=blocked-on-load-flake
node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
```

Report `blocked-on-load-flake` and exit; the quiet-host reverify pass retries the saved heal automatically.

Otherwise a red gate is a hard stop: do **not** re-push, and report the completion record and report `#{{ITEM_NUM}} →
ci-heal gate-red`:

```bash
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=gate-red
node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
```

### 5. Converge before re-push — self-review the heal (proportionate to the change)

Run this BEFORE step 4's `request`: the harness pushes exactly the commit it verified, so review comes first.

For anything beyond a trivial merge-only heal, spawn **one adversarial code-review subagent** on your heal diff
and **AWAIT its returned report as the verdict** — the same converge-before-handback discipline the delivery brief
uses ([delivery-agent-brief.md](delivery-agent-brief.md) step 6). Confirm the repair addresses the failing check
and introduces no new problem. Address every finding to convergence (fix it, or dismiss it with a one-line reason).
A trivial, obviously-correct heal (a clean merge with no code change) may skip the subagent.

### 6. Commit (before step 4's request) — the harness re-pushes it to the SAME lane ref

Commit only the heal's files (explicit paths, never `git add -A`; one commit) on the lane's current branch, BEFORE
step 4's `request`. Do **not** push `{{LANE_REF}}` yourself: on a green verdict for exactly this commit the harness
pushes it to update the existing PR's head — this **updates the PR**, it does not
open a new one (never `gh pr create`, never `pr-land` — the PR already exists):

```bash
printf '%s\n' "{{ATTRIBUTION}}: ci-heal — <failing check and repair> (PR {{PR_NUM}})" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> <explicit-paths>   # omit if the merge alone healed it and there is nothing new to commit
```

Write the commit message to a file and `commit -F` it — a heredoc runs backticks (e.g. `` `scope:` ``) as a
subshell (`bad substitution`); a message file has no such footgun. Pushing to `lane/*` is allowed by the
single-branch guard; pushing to `main` is not. If the harness reports a non-fast-forward push refusal, the remote
moved; reconcile with the current PR head, commit, and request + mark again. Never force-push over that refusal.

### 7. Post the durable CI-heal comment — the restart-surviving attempt tally (NEVER a label swap)

The harness re-pushed the heal. Record it with a durable comment — this is **the ONLY thing you write to the PR**, and it is
a comment, **NOT** a label change:

```bash
node "{{WE_ROOT}}/scripts/conveyor/ci-heal-mark.mjs" {{PR_NUM}} --repo={{REPO}} --reason={{REASON}} && \
  node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=<no-change|healed>
  node "{{WE_ROOT}}/scripts/conveyor/fix-procedure.mjs" fix-end {{PR_NUM}} --repo={{REPO}} --who={{SESSION_SLUG}}
```

`ci-heal-mark.mjs` posts one comment whose leading line is the CI-heal marker. The conveyor counts those comments
to bind the **retry cap across restarts** (#2666, mirroring #2643's re-arm-comment count), so the auto-heal can't
flap forever on a genuinely-broken diff. It makes **NO** label change: `review:human` / `review:pending` /
`review:changes` are untouched. **Do NOT** run `rearm-review.mjs`, **do NOT** `gh pr edit --add/--remove-label`,
**do NOT** touch `ready-to-merge` — only CI was repaired, so the PR's landability is decided exactly as before:
a `ready-to-merge` PR lands once its re-run CI is green (the drain), a parked PR still awaits its human `/review`.

**This completion record is the fix for the live incident that motivated this step** (#4075/xg7m2wq, PR #2724,
2026-09-26): without it, a finished ci-heal session kept counting as a live holder of its own PR — nobody ever
told the reconciler it was done. Use `--outcome=no-change` when step 2's clean merge alone healed it (no
commit at step 6); use `--outcome=healed` when step 3 made a real code repair.

### 8. Append a structured learnings entry to the session drop-box (#2614)

Append **exactly one** generalized-lesson entry (a friction hit, a missing convention, a doc/skill gap, an
improvement idea) from the heal — a write-time-gated scrub that rejects raw code, diffs, secrets, absolute/repo
paths, or PII, so keep every field a short generalized lesson:

```bash
node "{{WE_ROOT}}/scripts/conveyor/learnings-drop.mjs" \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" \
  --area="<coarse label, e.g. ci-heal / merge-on-main>" \
  --suggestion="<short recommendation>" \
  --session={{SESSION_SLUG}}
```

Skip only if you genuinely hit no generalizable friction.

### 9. EXIT — do not merge, do not touch the review label, do not release

For a permission-denial exit, RETURN `#{{ITEM_NUM}} → blocked-on-permission (<exact denied command>)`.
Use `blocked-on-infra` for outages/rate limits.

**Stop here.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the lane. Do NOT change ANY review
label. Your process EXIT is the signal you are done — but it is NOT the only signal: your **completion record**
(step 7, or whichever exit's own `report --status=done` you actually reached) is what tells the reconciler and
the session reaper that you are done, so it never counts a finished ci-heal session as a live holder of its PR
(the live gap this brief itself had until #4075/xg7m2wq — PR #2724, 2026-09-26). The conveyor's merge watcher
(`pr-watch.mjs {{PR_NUM}}`) and the next tick's state read (which now sees the CI recovering) carry it from
here — a `ready-to-merge` PR lands once its re-run `test` is green (the drain), a parked PR keeps its human gate.
Return a one-line result:
`#{{ITEM_NUM}} → PR #{{PR_NUM}} (ci-healed re-pushed | ci-heal escalated <reason> | ci-heal gate-red)`. A red gate /
red CI / conflict is NOT watcher-visible — your one-line RETURN is the only signal that surfaces it, so always
report it.

---

## Manual take-over — the human `/finish` path (SAME procedure)

The auto path above and a human healing a red/BEHIND conveyor PR by hand are **one procedure**. When a human takes
over: reconstitute on `{{LANE_REF}}` (don't rebuild), merge the live PR base into the lane, repair only the failing check, get the
locus gate green, re-push HEAD to the same `lane/*` ref, invoke the CI-heal completion marker to perform its guarded review handoff. The only difference between auto and manual is **who** does the repair; the reuse-the-ref, merge,
repair-only-CI, re-push, guarded-completion shape is identical.

## Guardrails (the non-negotiables)

- **Never edit the primary checkout** — all work is in the acquired lane clone (#104/#2183).
- **Never land the PR; use the completion marker for review handoff** — you stop at a re-pushed, CI-repaired PR. `review:human` /
  `review:pending` / `review:changes` remain protected. The marker carries an existing acceptance only with coverage proof, otherwise re-arms it. With a positively observed empty review family, its shared `--only-if=missing` boundary requires an OPEN PR and the pushed SHA, adds pending, and removes stale landing/red-team acceptance labels. Read, write or verification failures are reported separately from the healed branch; inspect the handoff result.
  The drain daemon is the sole writer to `main`; a human `/review` (or the drain AI-review) still owns any parked
  verdict.
- **Reuse the ref, never rebuild** — reconstitute from `{{LANE_REF}}`; if the ref is gone, report it, don't redo.
- **Repair only the CI break** — do not fold unrelated work in; do not weaken or delete a test to go green; if the
  diff itself is genuinely wrong (not a CI/merge break), escalate — don't paper over it.
- **Work only through the normal verbs** — `acquire --base=<ref>` → merge → repair → commit → `verify-lane.mjs request` +
  `await-verify.mjs mark` → end turn (the harness pushes `lane/*` on green) →
  `ci-heal-mark.mjs` → daemon/human. No parallel state store or hand-written review-label swap; the shared guarded completion command owns the handoff.
- **If you stop, say so IN YOUR COMPLETION RECORD** (#4075/xg7m2wq) — every exit above runs
  `completion-cli.mjs report --status=done` before it returns, starting with `report --status=started` at step
  0. A refusal (or a success) that leaves no completion record is indistinguishable from a still-live session,
  and the PR it was healing keeps reading as held by a live process — the exact live incident (PR #2724,
  2026-09-26) this rule exists to prevent. The record changes no PR label; it is read by
  `we:scripts/conveyor/reconcile-core.mjs#markSelfReportedDone` and `we:scripts/conveyor/session-reaper.mjs`'s
  own completion-record axis.
