---
kind: story
size: 2
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/check-standards.mjs", "we:scripts/lib/", "we:scripts/lib/__tests__/"]
tags: []
---

# Guard single-page read completeness

Prevention owed by the security finding in PR #7478: a reader requested `per_page=100`
but used a separate 300-result ceiling. The repair shares the request bound with the
refusal threshold in both drain compare readers. Add a standards check to catch this
class in future readers without changing unrelated admission policies in that repair.

## Acceptance

- [A1] **Must** — flag a single-page `per_page=N` read that accepts N results without
  proof of exhaustion. Planned test: `single-page reader accepting a full page is flagged`
  in `we:scripts/lib/__tests__/paged-read-completeness-rule.test.mjs`.
- [A2] **Must** — accept a bound shared by request and refusal, and a reader that follows
  pagination to exhaustion. Planned tests: `shared request and refusal bound passes` and
  `exhaustive pagination passes` in the same file.
- [A3] **Must** — any endpoint-specific exception requires documented completeness evidence
  and a named boundary test. Planned test: `unsubstantiated endpoint exception is flagged`
  in the same file. Do not assume every API paginates every response field identically.

## Non-goals

- Do not implement this general standards rule as part of PR #7478's compare-reader repair.

## Duplicate admission

Local backlog search found no card for a standards rule coupling single-page request
sizes to completeness checks. This records the latest review's explicit prevention debt.
