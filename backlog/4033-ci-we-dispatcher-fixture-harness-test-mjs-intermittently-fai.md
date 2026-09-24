---
bornAs: xgp2i18
kind: task
status: open
scope: ["we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# CI: we:dispatcher-fixture-harness.test.mjs intermittently fails with spawnSync node ETXTBSY under concurrent load

Observed on PR #2592 (test-shard 3/4, run 36034211361, job 107750159750,
2026-09-24T17:28Z): the test's execFileSync('node', [BACKLOG_CLI, 'build-queue', ...])
call failed with ETXTBSY ("text file busy"), a known transient race when the node
binary is being executed/written concurrently by another process on the same shared
runner (matches this session's finding of very heavy concurrent CI/lane activity
tonight, mirroring #3443's earlier-logged GitHub API rate limit hit from concurrent
gh call volume). Unrelated to the PR's own content (a docs-only backlog Progress-note
edit) -- re-running the same job is expected to pass.

Proposed systemic fix: wrap the test's execFileSync('node', ...) calls (and any other
test-harness spawns of the node binary by bare name) in a small retry-on-ETXTBSY
helper (a few retries with a short backoff), rather than let a shared-runner race fail
an unrelated PR's required check. Search scripts/lib and scripts/conveyor for other
tests that spawnSync/execFileSync 'node' directly and apply the same wrapper if this
is a shared pattern, or centralize it as a small we:scripts/lib/exec-retry.mjs helper.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
