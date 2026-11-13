---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/drain-mq-flake-rerun.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Reinforce the mq same-head flake retry with a rerun of the failing shard

The flake retry in we:scripts/lib/drain-queue-safety.mjs accepts separate passing evidence from the PR head CI and a later main run. It cannot rule out a deterministic failure from combining the two (accepted under R903+R907; the retry itself is the combined-commit rerun, once per head). Strengthen: also require a green rerun of the failed shard on the merge-group commit before re-enqueue, reusing we:scripts/lib/drain-mq-flake-rerun.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs` includes a case where the rerun of the failing shard fails and the retry is refused (red before, green after).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the quarantine retry or the once-per-head bound.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — same fail-closed parsing as the existing evidence readers.
2. **Truncated reads** — an incomplete rerun result holds.
3. **Shared state files** — n/a: no new state file.
4. **Fail closed** — any unreadable rerun evidence keeps the hold.
5. **Identity scoping** — rerun must be of this head's merge-group commit and shard.
6. **State over time** — once per head, recorded in the merge-queue timeline.
7. **Who wrote it** — n/a: evidence is read from GitHub Actions only.
