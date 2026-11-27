---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Parameterize the held-attempt it.each over executor route (claude-direct, wrapped, borrowed). (from web-everything/web-everything#7554 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1779` — Parameterize the held-attempt it.each over executor route (claude-direct, wrapped, borrowed).
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1913` — Add a releaseClaim-returns-{released:false} case and a WE_FIX_HOLD_LABEL env case.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1912` — Add one test where releaseClaim returns {released:false}, in the same fixture, and assert the reason contains 'claim-release-unconfirmed' on both the dispatchFix and resumeBgSession paths. A lint that flags new branches with no covering test would catch the class.
4. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:139` — Add a case with env:{WE_FIX_HOLD_LABEL:'hold:custom'} and a label list containing it. Assert hold-label and that the reason is the custom name. A second case with env.WE_FIX_DISPATCH_KILL_FILE and no explicit killFile would cover the default.
5. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:108` — Add parameterized tests named 'late hold blocks wrapped launch' and 'late hold blocks borrowed launch' in this test file, injecting holds during provider preparation and asserting zero launcher calls and reservation release; require each test to fail when its final guard is removed.
6. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1868` — Require a deterministic parameterized test gate covering late label and sentinel holds at each supported launcher, with launch suppression and claim-release assertions.
7. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:140` — Add a deterministic integration test for omitted killFile alongside the explicit-path cases, ensuring the default resolver remains connected to enforcement.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7554@2adf46c5786d76b91ad720e42ff4b6bc20cb37dd

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
