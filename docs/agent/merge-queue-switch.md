# Switching the drain to GitHub's merge queue

Today the drain merges each ready PR itself (`strategy: drain-direct`). The switch makes the drain enqueue
ready PRs on GitHub's native merge queue (GraphQL `enqueuePullRequest`); GitHub re-tests the group and merges,
while the drain's merge-time gates run in the required `merge-gate` CI check. Both pieces must be in place:
the ruleset (GitHub side) and the `mergeDelivery` repo setting (drain side).

## Files

- `we:scripts/rulesets/main-required-checks.merge-queue.json` — PUT body for ruleset `24883772`
  ("main: required checks"): the current rules plus a `merge_queue` rule with `merge_method: MERGE`,
  `max_entries_to_build: 5`, `min_entries_to_merge: 1`, `max_entries_to_merge: 5`,
  `min_entries_to_merge_wait_minutes: 5`, `grouping_strategy: ALLGREEN`, and
  `check_response_timeout_minutes: 60`. CI's real duration is about 11–22 minutes; 60 leaves headroom for a slow
  soak. It also adds `merge-gate` (GitHub Actions, `integration_id: 15368`) beside the required `test`, `smoke`,
  `daemon-soak`, and `soak-replay-gate` checks. The admin bypass (`RepositoryRole 5`, `always`) is kept.
  It also adds a `workflows` rule that pins `ci.yml`, `merge-gate.yml`, and `soak-replay-gate.yml` to
  `refs/heads/main` (`repository_id: 1142650361`). For `merge_group` runs GitHub reads workflow YAML from the
  group commit, so without the pin a PR could edit a workflow, or add one with a job named `merge-gate`, and
  turn a required check green. The pin does not replace that run: GitHub starts an extra run of each pinned
  file from `main`, and the rule passes only when those runs pass. The PR's own edited run still happens. This
  is layer (4) in the `merge-gate.yml` header. A test
  (`we:scripts/lib/__tests__/drain-merge-strategy.test.mjs`) fails when this body drifts from
  `node scripts/merge-gate-check.mjs --print-ruleset` (`rulesetSuggestion` in
  `we:scripts/lib/merge-queue-enqueue.mjs`).
- `we:scripts/rulesets/main-required-checks.rollback.json` — ruleset exactly as read on 2026-10-11 with
  `gh api repos/web-everything/web-everything/rulesets/24883772`: verbatim GET response, read-only fields included.
- `we:scripts/settings/merge-queue.json` → `mergeDelivery`: `strategy: github-merge-queue`, `batchSize: 5`,
  `maxGroupWaitMinutes: 5`, `mergeMethod: merge`. The last three values only document the ruleset values;
  GitHub reads them from the ruleset, not this file.

## How the drain resolves the strategy

- `loadMergeDeliveryPolicy` in `we:scripts/lib/merge-delivery-policy.mjs` resolves each key: standard default
  (`drain-direct`, batchSize 1) → platform preference `we:scripts/lib/delivery-platform-preferences.json`
  key `mergeDelivery` (today: `drain-direct`, batchSize 3) → repo settings, the merged
  `we:scripts/settings/*.json` top-level `mergeDelivery` block. The log calls the repo layer **`tool`**:
  confirmation is `strategy=github-merge-queue (tool)`, not `(repo)`.
- There is no env layer for the live strategy. `WE_DRAIN_MERGE_STRATEGY` is honoured only with `--dry-run`
  to preview which PRs would be enqueued. The one other input is a test seam: inside a test run (`VITEST` /
  `WE_UNDER_TEST`) the drain does not read the live `scripts/settings/*.json` for this block, and
  `WE_MERGE_DELIVERY_SETTINGS_FILE` replaces them with a given file. Do not set it on the resident drain.
- `mergeQueue.batchSize` / `mergeQueue.strategy` in the same file are a different, older knob: the drain's own
  queue ordering in `we:scripts/lib/merge-queue-hook.mjs`. A `mergeQueue.batchSize: 1` override never changed
  the logged `batchSize=3 (platform)` because the merge-delivery reader only reads `mergeDelivery`.
  Do not set `mergeQueue.strategy` to `forge-native-queue`: it is reserved/not built and invalidates the whole block.

## Preconditions

- [ ] PR #4715 merged: red-main freeze published to a shared ops branch CI can read; it carries card x09e2bn,
  the drain-side reader of that branch.
- [ ] `merge-gate` runs in **enforce**. PR #4715 does not itself set `mergeGate.mode`; enforce needs
  `mergeGate.mode: "enforce"` in a repo settings file or the `MERGE_GATE_MODE` repository variable
  (`we:scripts/lib/merge-gate-ci.mjs`, `loadMergeGateMode`). Confirm the merge-gate log shows `mode=enforce`.
  Apply step 4 re-checks this on a fresh merge-gate run on main and stops unless its log says `enforce`: in `shadow` the
  required `merge-gate` check passes with "SHADOW: would HOLD", so the queue would merge PRs the drain holds.
- [ ] Merge-gate shadow audit clean: no shadow "would HOLD" on a PR the drain then landed.
- [ ] Card `xjdnlk0` done: the pinned `workflows` runs are proven on a live PR. GitHub starts them only on
  opened, synchronize and reopened (plus `merge_group`), so a label or body edit may not re-run the pinned
  `merge-gate` or `soak-replay-gate`. They may also share a `cancel-in-progress` concurrency group with the
  repo's own runs and cancel them.
- [ ] Main's CI is green and the safety net has published no red: neither `main-ci-red-state.json` nor
  `main-red-priority.json` exists (`we:scripts/lib/red-main-hold.mjs`). A published main-fix PR is exempt from
  the freeze's hold, so the drain would still `gh pr merge` it.
- [ ] You can run `gh` with your own admin login and merge this PR by hand: the freeze below stops the drain
  from merging it.
- [ ] Card `xsvxy4v` done: the drain confirms a PR is `MERGED` before it records a landing. Without it, any
  drain that still reads `drain-direct` after the switch (a stale clone, a lane's `/pr` or `/finish` run, which
  reads its own branch's settings, a `pr-watch` fast drain, a manual `/drain`) records an enqueue as landed.
  The freeze and the clone check below cover only the drain clones; the switch window's stop list below
  covers the other drains for that window only.

## Why the drain must be frozen during the switch

The drain and the ruleset must change together, and they cannot. While the ruleset is on and the drain is still
`drain-direct`, the drain's non-admin `gh pr merge --merge` is turned into an enqueue by gh. The drain still
reports `merged:true`, adds the PR to `merged` / `landedThisPass`, posts its landed trace and starts post-land
work. The PR may then fail merge-group CI and never land. This is true in both directions (apply and rollback),
and a short window does not prevent it: any pass that starts inside it can do this. So no drain pass may merge
anything while the two disagree.

Use the existing manual red-main freeze for that. With `redMainHold: on` (the default, `we:scripts/settings/red-main-hold.json`)
the drain keeps running, but it skips every PR as `red-main-hold` and runs no `gh pr merge`; with `off` it stops
with exit 5 (`stopped: red-main-freeze`). It does not stop a pass already in flight (the freeze is read once, at
plan time), and `--no-red-main-freeze` / `WE_MERGE_BREAK_GLASS=1` skip it entirely: do not use either during the
switch. The marker lives in the host's coordination root, so it covers every drain clone, provided the freeze
command runs with the same `WE_COORDINATION_ROOT` / `WE_RED_MAIN_FREEZE` as the daemon: compare the `path`
printed by `status` with the path the drain uses. Run these on the drain host.

The drain reads `mergeDelivery` from its own clone's `scripts/settings/*.json`, and a clone only pulls main when
the drain lands something or its per-pass refresh succeeds (a failed refresh is non-fatal). So unfreeze only
after every drain clone has the settings commit (the clone check below).

Two paths get past this, so close both for the whole switch:

- **A published main-fix PR.** The freeze does not hold it (the exemption above). If main goes red and a fix PR
  is published before the ruleset step (apply step 4), do not take that step until the fix PR is merged and
  nothing is published. Once this PR has merged, the drain cannot land it (its enqueue fails with no queue), so
  merge it yourself with your admin login
  (`env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh pr merge <fix PR> --merge --repo web-everything/web-everything`).
  A clone that has not pulled this PR yet is still `drain-direct` and may merge it directly; with no ruleset yet
  that is a real merge, which is fine. The clone check comes before the ruleset for the same reason: a drain that
  already has the new setting only tries to enqueue, and without the ruleset the enqueue fails, so nothing is
  recorded as landed.
- **A drain run from a checkout that is not a drain clone.** The conveyor's `pr-watch` runs
  `scripts/merge-ai-prs.mjs` from its own checkout (its event-driven land), a lane's `/pr` or `/finish` runs it
  from that lane, and a manual `/drain` uses whichever checkout it runs in. Such a checkout reads its own
  `scripts/settings/*.json`, which the clone check does not cover. Until the last apply step: stop the conveyor
  (or run `pr-watch` with `--no-fast-drain`), let delivery and fix agents already running finish first, and run
  no `/pr`, `/finish` or manual drain.

## Apply order

1. Freeze the drain, then wait for the pass that was already running to end and for the next pass to log
   `red-main-hold` skips (or the exit-5 stop) with no `gh pr merge`:

   ```bash
   node scripts/readiness/red-main-remediation.mjs freeze --reason="merge-queue switch: ruleset apply"
   node scripts/readiness/red-main-remediation.mjs status   # frozen: true
   ```

   Also stop the conveyor (or run `pr-watch` with `--no-fast-drain`), wait for running delivery and fix agents
   to finish, and run no `/pr`, `/finish` or manual drain (see above).
   Do not go on until a pass that began after the freeze has finished. A pass already past its freeze check can
   still merge.
2. Merge this settings PR yourself, **before** the ruleset exists, so the merge needs no queue bypass. The
   frozen drain will not merge it. Do not go on until GitHub says it merged:

   ```bash
   env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh pr merge 4950 --merge
   gh pr view 4950 --json state,mergeCommit --jq '.state, .mergeCommit.oid'   # MERGED, <sha>
   ```

   Until step 4, the drain is `github-merge-queue` against an unqueued main. It is frozen, so it merges nothing
   except a published main-fix PR, and for a clone that has this commit that enqueue fails (see above).
3. Check every drain clone has the settings commit from step 2 (still frozen; a frozen pass still refreshes, so
   wait one pass if a clone is behind). Do this **before** the ruleset, so no clone is still `drain-direct` once
   the queue exists. Clones are listed by `daemonCloneRoots` in `we:scripts/lib/daemon-clone-registry.mjs`; for
   each:

   ```bash
   git -C <drain clone> merge-base --is-ancestor <merge commit sha> HEAD && echo ok
   ```

4. Apply the ruleset with the operator's personal gh, not the App token. First prove the mode CI really runs
   in. Do not resolve it locally: a local read cannot see an organization-level `MERGE_GATE_MODE` variable, and a
   failed variable read or a local settings edit would make it disagree with CI. Instead start the merge-gate
   dry run on main (`workflow_dispatch`, which resolves the mode on GitHub from main's settings and `vars`), and
   read the mode line from its log:

   ```bash
   GH="env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh"
   SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   $GH workflow run merge-gate.yml --repo web-everything/web-everything --ref main -f prs=4950
   # once it appears (a few seconds), take the dispatch run that started after $SINCE:
   RUN=$($GH run list --repo web-everything/web-everything --workflow merge-gate.yml --event workflow_dispatch --limit 1 --json databaseId,createdAt --jq ".[] | select(.createdAt >= \"$SINCE\") | .databaseId")
   $GH run watch "$RUN" --repo web-everything/web-everything >/dev/null
   $GH run view "$RUN" --repo web-everything/web-everything --log | grep -m1 -o 'merge-gate mode: [a-z]* (source: [^)]*)'
   ```

   The dry run needs a PR to evaluate (with none it fails before it resolves the mode); `4950` is fine even once
   merged, because the mode line is printed whatever the PR's verdict, and the run's own pass or fail does not
   matter here. Go on only if it prints `merge-gate mode: enforce (source: …)`. Anything else stops the switch:
   `shadow`, no such line, an empty `RUN`, or any failed command. Then apply:

   ```bash
   env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh api -X PUT repos/web-everything/web-everything/rulesets/24883772 --input scripts/rulesets/main-required-checks.merge-queue.json
   gh api repos/web-everything/web-everything/rulesets/24883772 --jq '.rules[].type'
   ```

   The readback must show `required_status_checks`, `merge_queue`, and `workflows`. GitHub's rules page
   describes ruleset workflows as an organization or enterprise feature, while ruleset `24883772` is a
   repository ruleset, so the PUT may be refused. If the PUT fails (for example HTTP 422) or `workflows` is
   missing from the readback, GitHub did not accept the pin. Do not retry the same body and do not unfreeze:
   run the rollback below. Moving the pin to an organization ruleset is a separate change. Confirm the pin itself:

   ```bash
   gh api repos/web-everything/web-everything/rulesets/24883772 --jq '.rules[] | select(.type=="workflows") | .parameters.workflows[] | "\(.path) \(.ref)"'
   ```

   It must list `ci.yml`, `merge-gate.yml`, and `soak-replay-gate.yml`, each at `refs/heads/main`.
5. Unfreeze, so the next pass reads the new setting and starts enqueueing:

   ```bash
   node scripts/readiness/red-main-remediation.mjs unfreeze
   ```

6. Confirm the next drain pass logs:

   ```text
   merge-delivery policy: strategy=github-merge-queue (tool), batchSize=5 (tool), maxGroupWaitMinutes=5 (tool), mergeMethod=merge (tool)
   ```

   If it logs `strategy=drain-direct` instead, freeze again at once (step 1) and re-check the clones (step 3)
   before you unfreeze. Once it logs `github-merge-queue`, restart the conveyor (or drop `--no-fast-drain`).

   If step 2 fails, nothing has changed: unfreeze and stop. If step 4 fails after step 2 succeeded, stay frozen.
   Retry it only for a transient error (a network failure or HTTP 5xx). For a refused body (HTTP 4xx) or a
   missing `workflows` rule, run the rollback below.

## First-batch proof to collect

- Drain log `github-merge-queue: ... enqueued PR(s) awaiting GitHub's merge` naming the PR(s), and a
  `we-drain-enqueue-clearance` comment on each enqueued PR.
- The queue as GitHub sees it:

  ```bash
  gh api graphql -f query='{repository(owner:"web-everything",name:"web-everything"){mergeQueue(branch:"main"){entries(first:20){nodes{position state pullRequest{number}}}}}}'
  ```

- `merge_group` runs of `test`, `smoke`, `daemon-soak`, `soak-replay-gate`, and `merge-gate` on the
  `gh-readonly-queue/main/...` ref, all green: `gh run list --event merge_group --limit 10`.
- PR shows merged by the queue; the main commit is a merge commit (2 parents); the drain's post-land
  follow-up ran for it (`mergedBy: github-merge-queue`).

## Rollback

Freeze the drain for the whole rollback, for the same reason as above: between the settings revert and the
ruleset restore, one side is always wrong (a `github-merge-queue` drain on an unqueued branch, or a
`drain-direct` drain on a queued one).

The order is the reverse of apply: ruleset first, then the settings revert, so the revert needs no queue bypass.
The same precondition applies (no published red).

1. Freeze and wait for a post-freeze pass with no `gh pr merge`, as in apply step 1
   (`--reason="merge-queue switch: rollback"`). Stop the conveyor (or use `--no-fast-drain`), let running agents
   finish, and run no `/pr`, `/finish` or manual drain, as above.
2. Restore the ruleset from the saved body, stripping read-only fields:

   ```bash
   jq '{name,target,enforcement,conditions,rules,bypass_actors}' scripts/rulesets/main-required-checks.rollback.json | env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh api -X PUT repos/web-everything/web-everything/rulesets/24883772 --input -
   ```

3. Read it back: `.rules[].type` is only `required_status_checks`, and `merge-gate` is absent from the required
   list. Dequeue entries still in GitHub's queue in the GitHub UI; the drain picks them up again as ready PRs.
4. Put the drain back: revert this PR (remove the `mergeDelivery` block, or set its `strategy` to
   `drain-direct`) and merge the revert yourself with `gh pr merge <revert PR> --merge` (the frozen drain will
   not). Confirm `gh pr view <revert PR> --json state,mergeCommit` shows `MERGED`.
5. Check every drain clone has the revert commit (apply step 3), then unfreeze
   (`node scripts/readiness/red-main-remediation.mjs unfreeze`) and confirm the next pass logs
   `strategy=drain-direct`. If it still logs `github-merge-queue`, freeze again and re-check the clones. Then
   restart the conveyor.
