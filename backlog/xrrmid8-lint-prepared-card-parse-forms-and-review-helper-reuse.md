---
kind: task
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/lib/", "we:scripts/__tests__/", "we:docs/agent/testing.md", "we:skills-src/review/"]
dateOpened: "2026-10-13"
tags: []
---

# Lint prepared-card parse forms and review helper reuse

PR #5207's preparation review found a plan that described canonical ID normalization incorrectly and accepted multi-line blocker lists without a named test. Add prevention to the preparation lint and review checklist so these omissions are caught before implementation.

## Scope

- Add a `check:standards` card lint that flags a prepared card whose Design names an accepted parse form without a matching named Test plan bullet. Use an explicit, documented form-to-test mapping if prose cannot be matched reliably; do not silently treat unmatched forms as covered.
- Add this review lens item: any normalization described in prose must cite and require importing the existing helper. Require a concrete canonical ID, filename, and lookup assertion for padded-ID plans.
- Document the test-plan rule that every accepted input form gets a named test. Fail-closed reader plans also require deterministic throwing-reader tests and lookup spies proving invalid tokens never reach paths or git arguments.

## Done when

- Prepared-card fixtures accepting inline and block lists but testing only inline lists fail the scoped standards gate; fixtures naming both tests pass. Include the missing/present `preparedDate` boundary and avoid flagging ordinary unprepared cards.
- The review checklist requires helper reuse and checks a `"043"` fixture against `backlog/043-*.md`, preserving canonical helper behavior for `"0043"`.
- The documented implementation test gate for card 5028 requires `multi-line blockedBy`, `padded id / canonical helper`, `unreadable blocker refuses`, and `invalid blocker never reaches lookup`, with no resolve call or commit on refused inputs.

## Next action

Implement the lint with prepared-card fixtures, add the review lens item, and run affected tests plus the scoped standards gate.
