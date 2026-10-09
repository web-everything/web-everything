---
bornAs: xccgzu5
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/fixer-stuck-reclaim.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/fixer-stuck-reclaim.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Fix daemon consumes fixer-stuck escalations: reclaim a stuck fixer's claim so the PR is re-dispatched

Live 2026-10-08: health-watch flagged [high] fixer-stuck pr:we#4453 for 14+ min; ci-heal-4453 kept the fix claim and a reserved ci-heal slot (starving #4447/#4439, scope-blocking #4446). The session watchdog writes session-watchdog.fixer-stuck events (contract v1) but nothing reads them, so no reclaim ever happens. Add a fix-daemon pass that consumes unacked events: when the stuck session still holds the claim and has no unpushed verify in flight, stop it, fix-end its claim, release its dispatch claim, clear its await record and ack the event, so the same tick re-dispatches a fresh ci-heal/fix.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
