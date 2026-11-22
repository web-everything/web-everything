---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/drain-queue-safety.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add an it.each over both kill-switch env keys that uses an empty thread, and one for waitForRedTe… (from web-everything/web-everything#7318 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/drain-queue-safety.test.mjs:1840` — Add an `it.each` over both kill-switch env keys that uses an empty thread, and one for waitForRedTeamBeforeEnqueue=false that calls `strategy.enqueue` with no proof. A review lens could also flag any 'guard off' test whose fixture would pass with the guard on.
2. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:1846` — Make the harness default thread empty and require each test to opt in to a policy-clear. Add explicit negative tests for "label present, no proof" and "gate off, empty thread" at strategy level. A lint that bans implicit proof fixtures in admission tests would catch the class.
3. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:55` — Add a deterministic parameterized regression for both disabling switches with an explicitly empty thread, asserting successful enqueue; require explicit evidence fixtures for admission-policy tests. This guard needs a future backlog filing.
4. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:53` — Add an explicit empty-thread regression test for each kill switch and require those tests to fail when the corresponding bypass is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7318@c51d73c2150ff2c34665b1850d035b7466450649

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
