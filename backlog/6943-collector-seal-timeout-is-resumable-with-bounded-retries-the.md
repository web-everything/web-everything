---
bornAs: x245i7o
kind: story
size: 3
parent: "6944"
status: open
blockedBy: ["6941", "6942"]
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector seal timeout is resumable with bounded retries then a held reason

Per decision 6940 fork 6 skeptic amendment: the root cause of the stuck batch is the seal job timing out (spawnSync ETIMEDOUT) and leaving step ready terminal. A seal timeout resumes from the last completed step with a bounded retry count (a setting with its source logged), then holds with a named reason.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-seal.test.mjs` fails before this item lands and passes after. Planned cases:
  - `timeout at step ready resumes from the last completed step on the next tick` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `seal plan starts at the step after the last completed one` (we:scripts/operations/__tests__/card-batch-seal.test.mjs) — the pure step plan in we:scripts/operations/card-batch-seal.mjs, given a recorded last completed step, returns the remaining steps only, and an unknown recorded step yields a held reason, not a restart.
  - `seal job killed mid-step re-runs that step and never records it complete` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — fault injection: the seal job is killed partway through `verify`. The state still names the previous step as the last completed one, the kill counts as one timeout, and the next tick re-runs `verify` from its start.
  - `retry count is bounded by the setting, with its source logged` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `retry exhaustion holds with a named reason` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the state keeps sealedAt and the held reason names the timed-out step.
  - `seal scan does not relaunch a batch whose retries are exhausted` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — after exhaustion, three further `sealDueBatches` scans spawn no seal job, the retry count does not grow, the held reason is unchanged, and the PR is never marked ready.
  - `retry count is per batch and starts at zero for a fresh batch` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — with one batch at its retry limit, (a) the next fresh batch of the same repo and kind, opened after that batch retired (its PR merged, per 6941), (b) a batch of another kind in the same repo, and (c) a batch of the same kind in another repo each start at zero retries and are not held.
  - `timeout during number-members then resume leaves each member numbered exactly once` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a timeout injected partway through 6942's numbering step, then a resume, leaves every member with exactly one number, no half-renumbered head, and no extra numbers allocated. This is a cross-slice case, so 6943 lands after 6942.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Numbering itself (6942) and retiring a finished batch (6941) are their own slices.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the inputs are the seal job's own state and its exit result.
2. **Truncated reads** — a seal job killed partway through a step counts as a timeout; that step re-runs from its start and is never recorded as complete (case `seal job killed mid-step re-runs that step and never records it complete`).
3. **Shared state files** — the retry count and last completed step live in the state file, written under the per-kind lease.
4. **Fail closed** — retry exhaustion holds with a named reason and never marks the PR ready, and the seal scan never relaunches the exhausted batch (cases `retry exhaustion holds with a named reason`, `seal scan does not relaunch a batch whose retries are exhausted`).
5. **Identity scoping** — the retry count belongs to one batch (repo, kind, seq) and starts at zero for a fresh batch (case `retry count is per batch and starts at zero for a fresh batch`).
6. **State over time** — resume from the last completed step, after 6942's journal check (a member without `numberedPath` restarts the seal at `number-members`); a resumed `number-members` numbers each member exactly once (case `timeout during number-members then resume leaves each member numbered exactly once`).
7. **Who wrote it** — n/a: only the seal job writes seal progress.
