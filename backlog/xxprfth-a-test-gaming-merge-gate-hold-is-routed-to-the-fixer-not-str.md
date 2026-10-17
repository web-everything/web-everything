---
kind: story
size: 3
status: active
scaffoldedBy: "test-gaming-route"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/test-gaming-route.mjs", "we:scripts/conveyor/__tests__/test-gaming-route.test.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/review-settings.json", "we:scripts/lib/review-settings.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# A test-gaming merge-gate hold is routed to the fixer, not stranded

When the only failing merge-gate rule is test-gaming (a net removal of test cases), the review daemon currently logs review-hold-red and nobody acts; PR #5487 sat stranded for 2.5 h. Route that hold to the existing fixer with a binding restore-or-justify instruction, once per (PR, head), behind review.routeTestGamingToFixer (default on). A justified removal goes to needs-you; the guard is never auto-cleared.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/test-gaming-route.test.mjs` fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the test-gaming guard itself or auto-clear a hold.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the file list comes from the gate output and is quoted, never executed.
2. **Truncated reads** — a truncated or unreadable gate summary routes nothing (fail closed).
3. **Shared state files** — n/a: one marker comment per (PR, head) is the ledger.
4. **Fail closed** — unknown or mixed failing rules keep today review-hold-red behaviour.
5. **Identity scoping** — dedupe key is (PR, head SHA); a new head re-arms within the round cap.
6. **State over time** — one dispatch per head; the existing round cap applies.
7. **Who wrote it** — only the daemon own marker comment counts; a human comment cannot spoof it.
