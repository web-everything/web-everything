---
bornAs: xhjuluf
kind: story
size: 5
parent: "6236"
status: open
blockedBy: ["6233"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 5 — advisory lessons on the ledger

Advisory findings are recorded in the ledger and never fixed per PR. A weekly job turns recurring classes into builder lessons, with settings advisory.lessons.enabled, schedule, recurrenceThreshold and promoteToRule (proposed only).

## Acceptance

- [A1] **Executable** — ledger integration test `advisory-ledger-record` records an advisory finding with repository, PR, stable finding id, class and time while leaving the PR free of a per-PR fix requirement; replay does not duplicate the entry.
- [A2] **Executable** — controlled-clock job test `lesson-recurrence-threshold` emits no lesson at threshold minus one (initially four), emits at threshold (five) and above within one class/week, and does not combine different classes or weeks to reach the threshold.
- [A3] **Executable** — job integration test `lessons-disabled` sets `advisory.lessons.enabled=false` with otherwise qualifying findings and observes no lesson or rule proposal; ledger recording remains enabled.
- [A4] **Executable** — job integration test `promote-to-rule-proposes-only` exercises promotion enabled and disabled; enabled produces an operator proposal and disabled produces none, and neither changes a rule, setting, current level or invariant without a separately authenticated operator approval through slice 2's writer.
- [A5] **Executable** — production lesson-writer test `lesson-content-template-only` repeats injected-instruction findings to the threshold, including newline/CR/U+2028, backticks, quotes, leading options, traversal text, Unicode lookalikes/invisibles and joined fragments. Agent-facing lessons use only a trusted fixed template with validated closed class token and numeric count; no finding, diff, title, URL or PR-body prose is interpolated. Typed repository/PR/finding provenance is kept as separate data, never instruction text. Rule proposals use the same boundary.
- [A6] **Executable** — clock-driven integration test `lesson-weekly-schedule` uses the configured Sunday 20:00 America/Toronto schedule across daylight-saving changes; each class/week is emitted once, including retry after restart and concurrent job attempts, with atomic output and a revision/idempotency check.
- [A7] **Executable** — job integration test `lesson-input-unreadable` supplies incomplete pagination, truncated/unreadable ledger, invalid class/count and malformed settings; the job reports failure without publishing a partial lesson/proposal or advancing its checkpoint.
- [A8] **Executable** — job test `lesson-input-bounds` rejects a ledger entry or fetched page above 1 MiB and class tokens above 128 UTF-8 bytes; count is a nonnegative safe integer. Stream complete pagination with a 120-second run budget; exceeding the budget fails without publication or checkpoint advancement, never treating a partial read as complete. Body-size is enforced on fetched data, not an HTTP listener. Rate limit `n/a:` for incoming requests and CSRF/origin `n/a:` because this is a scheduled local job with no receive endpoint or browser credentials; A6 enforces one active emission per class/week, and a failed or repeated trigger cannot reset state or multiply output. Ledger ingestion uses slice 2 A16's protected ingress bounds.

Ruling and amended table: [we:backlog/6239](/backlog/6239-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No per-PR advisory repair, free-form model-authored standing instructions, automatic rule promotion or independent settings-write authority.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — fixed class/count templates exclude all PR-derived prose from lessons and proposals; provenance remains separate typed data (A5).
2. **Truncated reads** — complete ledger/settings input is required before output or checkpoint advancement (A7).
3. **Shared state files** — atomic idempotent writes handle concurrent jobs and restart (A1, A6).
4. **Fail closed** — invalid input publishes nothing (A7); disabled lessons produce no lesson or promotion (A3), and promotion cannot apply a rule (A4).
5. **Identity scoping** — repository/PR/finding provenance stays attached to ledger entries and separate from agent instructions (A1, A5).
6. **State over time** — recurrence counts are per class/week (A2) and scheduling uses America/Toronto, including DST and retry (A6).
7. **Who wrote it** — the job emits trusted templates only; effective rule edits still require the authenticated operator writer (A4–A5).

## Risks

Stored PR prose could become agent instructions (A5), retries or scheduling could duplicate/promote lessons (A1–A4, A6), and incomplete or oversized input could publish misleading output (A7–A8).

## Test plan

Planned file `we:scripts/__tests__/review-stringency-lessons.test.mjs` owns all named A1–A8 cases and observable assertions above. In particular, `lesson-content-template-only` must inspect the production writer's agent-facing output, and `lesson-input-unreadable`/`lesson-input-bounds` must observe no publication or checkpoint change. These tests remain implementation work.
