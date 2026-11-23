---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/lib/__tests__/deps-job-no-packages.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a contract test that feeds passExitCode and fail outputs through the handler and asserts the… (from web-everything/web-everything#7380 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:1182` — Add a contract test that feeds `passExitCode` and `fail` outputs through the handler and asserts the failure detail survives in `what`. Alternatively, export the drain exit-code table and have the handler import it.
2. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1276` — Return a `dispatchBlocked` flag from the supersede stage that the fix and CI-heal halves honour. Add a test that the other halves still run when it is set.
3. `we:scripts/lib/enqueue-on-event.mjs:1187` — Add a lint or check:standards rule requiring child stderr or stdout interpolated into log or result strings to go through the shared log-sanitising helper.
4. `we:scripts/lib/__tests__/deps-job-no-packages.test.mjs:40` — Add a deterministic CI integration test that starts the deps job in a package-free snapshot and asserts that a dependency specified by its lockfile becomes installed.
5. `we:scripts/lib/__tests__/deps-job-no-packages.test.mjs:40` — Add a deterministic CI integration test that launches the deps job in an isolated fixture without node_modules and asserts successful installation of the fixture's locked dependency.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7380@45ff9ea37a5cedd2894b43f7c29eddce3a5ee516

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
