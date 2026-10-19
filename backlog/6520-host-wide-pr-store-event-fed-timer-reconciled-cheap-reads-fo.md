---
bornAs: xdk2pq6
kind: story
size: 8
status: open
scope: ["we:scripts/pr-context.mjs", "we:scripts/lib/gh-throttle.mjs", "we:scripts/conveyor/"]
dateOpened: "2026-10-18"
tags: []
---

# Host-wide PR store: event-fed, timer-reconciled, cheap reads for every daemon

One writer: one small service owns a host-wide PR store of open PRs (number, head sha, base, labels, mergeable state, check rollup, updatedAt, fetchedAt). GitHub webhook/pr-events update it at once. A timer reconcile (prStore.reconcileSec, default 300, source logged) does one batched GraphQL list to catch missed events. Readers: every daemon (drain listing, review, parked-pr-conflict-watch, ci watches, health-watch) reads the store instead of listing PRs itself. It builds on the batch-3 shared snapshot in we:scripts/pr-context.mjs. Live reads for safety: hold and guard decisions (red-team hold, overlap-yield, couple/sibling state, exact-head checks) still read live. The store must never decide a hold, which is the rule the 2026-10-18 prototype guard audit enforced. Live reads use ETag conditional requests where possible, since a 304 does not count against the rate limit (we:scripts/lib/gh-throttle.mjs). Freshness: each row carries fetchedAt. A reader passes maxAgeSec and falls back to a live read when the row is older. Evidence: on 2026-10-18 the GraphQL rate limit was exhausted repeatedly. The gh-throttle shared backoff at 21:56Z and 00:03Z blocked daemon rebuild smokes and every parked-pr-conflict-watch run. Drain listing takes 1-4 min per pass. After the restart, every run hit the 'no gh slot' 6-slot host cap. Related cards: the hotfix lane x8zfjb5, per-daemon prototypes xd6bq9f, and open card 4282 (daemons read the Worker PR ledger; this card is the host-local store that complements it). Scope paths: we:scripts/pr-context.mjs, we:scripts/lib/gh-throttle.mjs, we:scripts/conveyor/.

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
