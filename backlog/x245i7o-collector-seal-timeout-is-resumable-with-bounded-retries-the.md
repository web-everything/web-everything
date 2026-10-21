---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt", "x1mmp60"]
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector seal timeout is resumable with bounded retries then a held reason

Per decision x5ioz96 fork 6 skeptic amendment: the root cause of the stuck batch is the seal job timing out (spawnSync ETIMEDOUT) and leaving step ready terminal. A seal timeout resumes from the last completed step with a bounded retry count (a setting with its source logged), then holds with a named reason.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-seal.test.mjs` fails before this item lands and passes after. Planned cases:
  - `timeout at step ready resumes from the last completed step on the next tick` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `seal plan starts at the step after the last completed one` (we:scripts/operations/__tests__/card-batch-seal.test.mjs) — the pure step plan in we:scripts/operations/card-batch-seal.mjs, given a recorded last completed step, returns the remaining steps only, and an unknown recorded step yields a held reason, not a restart.
  - `retry count is bounded by the setting, with its source logged` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `retry exhaustion holds with a named reason` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the state keeps sealedAt and the held reason names the timed-out step.
  - `timeout during number-members then resume leaves each member numbered exactly once` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a timeout injected partway through x1mmp60's numbering step, then a resume, leaves every member with exactly one number, no half-renumbered head, and no extra numbers allocated. This is a cross-slice case, so x245i7o lands after x1mmp60.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Numbering itself (x1mmp60) and retiring a finished batch (x5nmdnt) are their own slices.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the inputs are the seal job's own state and its exit result.
2. **Truncated reads** — a seal job killed partway through a step counts as a timeout; that step re-runs from its start and is never recorded as complete.
3. **Shared state files** — the retry count and last completed step live in the state file, written under the per-kind lease.
4. **Fail closed** — retry exhaustion holds with a named reason and never marks the PR ready (case `retry exhaustion holds with a named reason`).
5. **Identity scoping** — the retry count belongs to one batch (repo, kind, seq) and starts at zero for a fresh batch.
6. **State over time** — resume from the last completed step; a resumed `number-members` numbers each member exactly once (case `timeout during number-members then resume leaves each member numbered exactly once`).
7. **Who wrote it** — n/a: only the seal job writes seal progress.
