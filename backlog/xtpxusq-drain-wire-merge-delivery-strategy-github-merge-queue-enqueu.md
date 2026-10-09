---
kind: story
size: 5
status: resolved
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue.json", "we:scripts/merge-gate-check.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# drain: wire merge-delivery strategy github-merge-queue (enqueue instead of merge, enqueue clearance, queue follow-ups)

Modules + tests landed with the merge-gate PR (we:scripts/lib/merge-delivery-policy.mjs, we:scripts/lib/merge-queue-enqueue.mjs, we:scripts/lib/merge-gate-ci.mjs). The wiring into we:scripts/merge-ai-prs.mjs is deferred because that file is held by #4624 (review:changes + review:human) and #4631. Wire: (1) resolve the policy once per pass via loadMergeDeliveryPolicy and log formatMergeDeliverySourcesLine every pass; (2) at the merge site, when mergeActionFor(policy) is enqueue, strip the transient manifest first (needsManifestStripBeforeMerge), then enqueuePr with the pinned head instead of mergePr, and skip the drain freshness refresh (the queue owns freshness); (3) stamp a trusted drain enqueue-clearance marker comment for the head so merge-gate's couple-whole/blocked-by gates (fail closed today for manifest couples) can read it, and teach we:scripts/merge-gate-check.mjs to read it; (4) each pass run the existing post-land follow-up (numbering, regen, resolve-on-land) for planQueueFollowUps(merged-by-queue PRs); (5) retire or alias the drain-internal mergeQueue.strategy in we:scripts/settings/merge-queue.json (held by #4689) so the cascade has one strategy key. Keep drain-direct byte-identical. Proof: live enqueue of one accepted PR, merged by GitHub, follow-up run.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/drain-merge-strategy.test.mjs` fails before (no module, no hooks in we:scripts/merge-ai-prs.mjs) and passes after: drain-direct makes no enqueue and no extra `gh` call; github-merge-queue enqueues only local-repo PRs pinned to the judged head, stamps the clearance first, never calls the merge API; an enqueue failure throws (reported as a failed land, never a direct merge); a GitHub-merged PR joins `merged` + `landedThisPass` exactly once.
- [A2] Every existing `we:scripts/__tests__/merge-ai-prs*.test.mjs` passes unchanged (drain-direct byte-identical apart from the one policy log line per pass).
- [A3] Live: the drain logs `merge-delivery policy: strategy=… (source)` each pass; `WE_DRAIN_MERGE_STRATEGY=github-merge-queue node we:scripts/merge-ai-prs.mjs --label=ready-to-merge --dry-run` prints `would ENQUEUE …` and calls no merge API. The live strategy stays `drain-direct` until the operator flips it after enabling the ruleset.

Delivered in we:scripts/lib/drain-merge-strategy.mjs (all logic) + seven hook lines in we:scripts/merge-ai-prs.mjs. Manifest strip needs no hook: the rebase-drop step already strips every landable manifest PR before the land cascade.

Deferred to follow-up cards (files held by other work): wiring `readEnqueueClearance` into we:scripts/merge-gate-check.mjs (held by the red-main-freeze-shared agent; its `facts.enqueueClearance = null` line sits next to their `facts.redMain` line) plus choosing the trusted author list; retiring/aliasing `mergeQueue.strategy` in we:scripts/settings/merge-queue.json (held by #4689).

## Non-goals

- [N1] Does not flip the live strategy (operator does that after enabling the GitHub ruleset). Does not enqueue sibling-repo PRs (impl halves stay drain-direct: the tool layer is this repo's settings and a sibling may have no merge queue).

## Edge cases this change must handle

1. **Untrusted text** — the clearance reader counts only comments from a configured trusted author whose marker names the exact current head; an empty trust list covers nothing.
2. **Truncated reads** — a failed follow-up `gh pr view` keeps the PR pending (retried next pass); an unread comment list re-stamps the clearance rather than skipping it.
3. **Shared state files** — the follow-up list is written atomically (temp file + rename) under the coordination root; only the drain writes it.
4. **Fail closed** — enqueue failure, missing pinned head, or dry run all throw before any merge; the PR stays `skip` and keeps blocking its dependents.
5. **Identity scoping** — pending entries are keyed by repo + PR number.
6. **State over time** — a queued PR stays blocking dependents until GitHub merges it; closed-without-merge entries are dropped; the followed-up list is capped at 500.
7. **Who wrote it** — the clearance trust check reads the comment author login, never marker text alone.
