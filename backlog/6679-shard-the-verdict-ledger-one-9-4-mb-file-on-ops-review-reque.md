---
bornAs: x33b7wo
kind: story
size: 5
status: open
scope: ["we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/lib/git-transport-branch.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Shard the verdict ledger: one 9.4 MB file on ops/review-requests loses push races

Root cause behind #5752's referral-persistence-failed (2026-10-20). Every verdict-ledger append (we:scripts/lib/verdict-ledger-io.mjs appendLedgerRows) fetches ops/review-requests, rewrites the single ledger file for web-everything (9,452,914 bytes), commits and pushes, with 5 attempts and ~3 s total backoff (100..1600 ms). Measured on the branch 14:40-15:25Z: 2-4 ledger commits per minute (peak 4/min at 15:03Z), while one attempt (fetch + worktree + commit + push of a 9.4 MB blob) takes tens of seconds under host load 3.5-5/core, so an attempt almost always races another writer. Two review runs on #5752 head 3c3cda0db (14:44Z and 15:16Z) each lost all 5 races ('failed to push some refs'); the same miss refused clearing verdicts on other PRs (telemetry p5690, p5765: 'verdict-ledger write refused for a clearing verdict (F4)'). Fix options: shard the ledger (per-PR files or append-only segment files, so concurrent writers touch different paths), or move it behind the shared data service (memory epic xwu9oxh). Acceptance: under the live write rate, appends no longer exhaust their retries; the read side still fails closed (unreadable != empty).

## Acceptance

- [A1] **Executable** — a vitest running at least 4 concurrent appenders against a local bare remote at the measured live rate fails today (an append exhausts its retries) and passes once appends for different PRs no longer contend on one file.
- [A2] **Must** — a read that cannot complete is still `unreadable` and every gate still holds on it; a missing shard never reads as "no verdict".

## Non-goals

- [N1] No change to the row schema or to which events are recorded; only where and how rows are stored.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: rows are validated by checkLedgerAppendRows before any write; sharding adds no input.
2. **Truncated reads** — a shard read cut short or over the read cap is `unreadable`, never a short ledger.
3. **Shared state files** — the point of the item: concurrent writers touch different paths (or the data service); still never a force-push.
4. **Fail closed** — a missing or unreadable shard holds its PR, as today.
5. **Identity scoping** — shards are keyed by repo and PR number; a row never lands in another PR's shard.
6. **State over time** — the current single file stays readable (migration or dual read) until every reader reads shards.
7. **Who wrote it** — n/a: the push-ref allowlist and writer identity are unchanged.
