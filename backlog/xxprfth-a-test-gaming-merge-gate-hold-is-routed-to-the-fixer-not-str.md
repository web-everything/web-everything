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

1. **Untrusted text** — PR-controlled gate paths must use ASCII letters, digits, `_./-`, contain no empty, dot, parent or leading-double-dash components, and fit 240 characters. Gate reasons fit 64 KiB; comments quote at most ten distinct paths as code plus an omitted count. Tests: `refuses unsafe gate-derived path`, `bounds gate-derived file lists and refuses oversized evidence`.
2. **Truncated reads** — a truncated or unreadable gate summary or incomplete comment read routes nothing (fail closed). Tests: `refuses unreadable evidence or state`, `incomplete comment read`, `deduplicates a route found only in the complete comment read`.
3. **Shared state files** — n/a: one marker comment per (PR, head) is the ledger.
4. **Fail closed** — unknown or mixed failing rules keep today review-hold-red behaviour. Tests: `refuses unknown gate evidence`, `refuses unusable removal evidence`, `keeps other failing merge rules on the existing path`.
5. **Identity scoping** — dedupe key is (PR, head SHA); a new head re-arms within the round cap. Tests: `admits one new repair after a head change within the round cap`, `ignores a justified fix-end for a different head`, `recognizes a matching newline-delimited fix-end head`.
6. **State over time** — one dispatch per head; the existing round cap applies. Tests: `admits the same head only once and does not dispatch another fix after completion`, `retains the existing advisory round cap`.
7. **Who wrote it** — only trusted marker authors count. Tests: `ignores forged route and justification markers`, `rejects an outsider %s after the legitimate route`, `ignores an untrusted newer advisory note when completing its own route`.

## Risks and test plan

The routing must remain bound in the production daemon, and one failed PR must not stop others. Tests: `binds the real test-gaming sweep in the production CLI daemon effects`, `replans a daemon tick from the routed labels so no competing review launches`, `continues routing subsequent PRs after one PR throws on %s`.

Replay `test-gaming-new-head-stranded` covers the live #5487 hold through the real sweep, daemon tick and planner with a later push after a newline-scoped completion. It asserts the new repair is offered to the existing fix dispatcher while the merge-gate hold remains in force.

## Review prevention record (PR #5537)

- Production wiring and per-PR isolation are pinned by the named integration tests above.
- Each applicable edge case now cites a regression test; trust-gated completion and notification readers are exercised after a legitimate route exists.
- The settings cascade test opposes platform true with tool false and checks both effective value and provenance.
- Path validation and output bounds live in one removal-evidence helper; malformed records appended to valid evidence fail closed. Tests: `refuses a malformed removal appended to valid evidence`, `bounds gate-derived file lists and refuses oversized evidence`.
- General standards rules mapping all cards' edge cases and header guarantees to tests, and a shared path formatter for other gate-to-agent consumers, remain separate platform work; this repair records those prevention requests without widening the routing change.
