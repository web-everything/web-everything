---
bornAs: xisj9gw
kind: story
size: 2
status: open
scope: ["we:coordination/drain-merge-queue-batching.json", "we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Drain: isolation starves the queue because catch-up fast drains time out

MED priority hint. ## (held 2026-10-27 12:10 ET) Drain: isolation starves the queue because catch-up fast drains time out Evidence: batching state (we:coordination/drain-merge-queue-batching.json) held isolate=[5968,5991] plus culprits 5936 and 6000. In isolate mode `admitEnqueue` (we:scripts/lib/merge-queue-adaptive-batching.mjs:199) refuses every other PR ("isolating culprit among ..."), yet the catch-up still spent a full fast drain on each. Fast drains run one at a time with `FAST_DRAIN_TIMEOUT_MS = 10 * 60_000` (we:scripts/lib/enqueue-on-event.mjs:97). Under gh throttle `listing`/`listing.context` took 180-300s per run, so #5874/#5970/#5978/#5968 timed out at 600s and used up catch-up budget. The isolate PRs themselves hit the timeout (#5968) and a gh-throttle ETIMEDOUT (#5991), so isolation never resolved. The same single-PR drain run alone took 211s and enqueued #5968. Fix: (1) in the catch-up planner (we:scripts/lib/enqueue-on-event.mjs ~452 and ~894-911), in isolate mode run fast drains only for isolate members and skip the rest without spending a fast-drain slot or catch-up retry; (2) a timeout caused by gh throttle (listing time over half the timeout) must not decrement the PR's catch-up budget; (3) reuse one listing snapshot (`--listing-snapshot` exists) so each child skips the 3-5 min listing. Also: "already queued" for #5936 (we:scripts/lib/enqueue-on-event.mjs:494, from isInMergeQueue) was reported while GitHub's queue held only #5993. Proof required: before/after log of a catch-up round in isolate mode where the isolate PR is enqueued within one round.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
