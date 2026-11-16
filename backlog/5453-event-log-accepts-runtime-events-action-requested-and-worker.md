---
bornAs: xwgwm0b
kind: story
size: 3
parent: "5452"
status: resolved
blockedBy: ["4283"]
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/lib/pr-events.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-11-15"
dateResolved: "2026-11-15"
tags: []
---

# Event log accepts runtime events: action-requested and worker started/finished, with per-class retention

Ruling E3: one log, one order. Besides GitHub facts, the log takes action-requested events (written by the decider) and worker started/finished events (written by executors), all under the same seq. Facts compact; runtime and judgment events are kept.

## Acceptance

- [A1] **Executable** — a test in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs appends an action-requested event and a worker-finished event between two GitHub facts and reads all four back in one rising `seq`; it fails today (the log takes GitHub facts only).
- [A2] Action-requested events carry an idempotency key (repo, PR, head commit, action kind, cause), where cause is the round number or the `seq` of the judgment that made the action owed.
- [A3] Appending the same key twice stores it once.
- [A4] Retention is per class: GitHub facts compact; action-requested, worker and judgment events are kept.
- [A5] Only an authenticated internal writer may append runtime events; the webhook path still accepts only signed GitHub deliveries.

## Non-goals

- [N1] Ledger verdicts and rulings joining the stream is 5456.
- [N2] No consumer changes; the decider and executors come later.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — runtime event bodies are schema-checked; free text fields are stored, never interpreted.
2. **Truncated reads** — reads keep the existing `more` paging; a partial page never advances a reader.
3. **Shared state files** — the Durable Object is the single writer of `seq`.
4. **Fail closed** — an event that fails the schema is refused with an error, never stored partly.
5. **Identity scoping** — events are per repo; the key includes the PR head commit.
6. **State over time** — retention classes keep runtime and judgment events past fact compaction.
7. **Who wrote it** — every runtime event records its writer (decider or the executor role and clone).

## Review prevention follow-ups (PR #6889)

The 2026-11-15 review requested prevention filings; these remain open work, not implemented guards:

- #8365 — SQL row-size-safe idempotency storage, a shared size-limited storage double, maximum lengths for every strict-validator string, and replay-only key expiry (correctness/correctness and security/resource-bound).
- #8366 — shared memory/SQLite adapter contract, migration, pruning, gap and bootstrap-freshness tests (correctness/test-coverage and security/coverage).
- #8367 — invalid retention bounds and valid zero-runtime-row edge (security/coverage).
- #8368 — populated webhook health/projection isolation and a successful-write snapshot review checklist (correctness/test-coverage, security/coverage and simplicity advisory).
- #8369 — advertised default retention boundaries and a named-test review checklist for numeric defaults and 'never X' promises (correctness/test-coverage, security/coverage and simplicity advisory).
- #8370 — client failure-path no-retry and credential-redaction tests (simplicity and codex-correctness advisories).

The 2026-11-16 advisory's owed prevention is captured in #8365 A5–A6, #8368 A4 and #8369 A4. Its later-round suggestions remain follow-up work: the cards now name their planned tests, #8365 A7 covers replay-only expiry, and #8366 A6 covers bootstrap freshness. No production behavior changes or human-review verdict is implied by these filings.
