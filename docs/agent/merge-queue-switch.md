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
  to preview which PRs would be enqueued.
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
- [ ] Merge-gate shadow audit clean: no shadow "would HOLD" on a PR the drain then landed.
- [ ] No PR is mid-merge in the drain; let a pass finish.

## Apply order

1. Apply the ruleset with the operator's personal gh, not the App token:

   ```bash
   env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh api -X PUT repos/web-everything/web-everything/rulesets/24883772 --input scripts/rulesets/main-required-checks.merge-queue.json
   gh api repos/web-everything/web-everything/rulesets/24883772 --jq '.rules[].type'
   ```

   The readback must show `required_status_checks` and `merge_queue`.
2. Merge this settings PR. Between steps 1 and 2 the drain is still `drain-direct`: its non-admin
   `gh pr merge --merge` on a queue-protected branch is turned into an enqueue by gh, and the drain records it
   as landed before GitHub merges it. Keep this window short: merge this PR right after step 1, ideally with
   no other PR ready in that pass.
3. Confirm the next drain pass logs:

   ```text
   merge-delivery policy: strategy=github-merge-queue (tool), batchSize=5 (tool), maxGroupWaitMinutes=5 (tool), mergeMethod=merge (tool)
   ```

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

1. Put the drain back first: revert this PR (remove the `mergeDelivery` block, or set its `strategy` to
   `drain-direct`). With the ruleset still on, direct merges become enqueues (see the window note above),
   so do step 2 promptly.
2. Restore the ruleset from the saved body, stripping read-only fields:

   ```bash
   jq '{name,target,enforcement,conditions,rules,bypass_actors}' scripts/rulesets/main-required-checks.rollback.json | env -u GH_TOKEN -u GITHUB_TOKEN /opt/homebrew/bin/gh api -X PUT repos/web-everything/web-everything/rulesets/24883772 --input -
   ```

3. Read it back: `.rules[].type` is only `required_status_checks`, and `merge-gate` is absent from the required
   list. Dequeue entries still in GitHub's queue in the GitHub UI; the drain picks them up again as ready PRs.
