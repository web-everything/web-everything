---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/await-verify-loop.mjs", "we:scripts/conveyor/ci-heal-loop.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/await-verify-loop.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-loop.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Extract the child wiring from main() into an exported wireCiHealLoop({awaitLoop, ...}) factory an… (from web-everything/web-everything#7248 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1941` — Extract the child wiring from `main()` into an exported `wireCiHealLoop({awaitLoop, ...})` factory and test its behaviour (a tick starts the child, `current()` skips inline, shutdown stops it). Alternatively, add a check that a new daemon child spawn point has a test.
2. `we:scripts/conveyor/await-verify-loop.mjs:317` — Add a supervisor test where `error` fires and then the child is shown to be alive. Clear `child` on `error` only when `child.pid` is undefined or the process is no longer running.
3. `we:scripts/conveyor/ci-heal-loop.mjs:197` — Add a table test over (marker, idNow, knownIdentity) with null combinations to decideRecloneBlock/cloneDispatchBlock. Where a comment promises fail-closed behaviour, pin it with a named test (a standards rule could require one).

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7248@bd92d39363f997be386e6ec7a715529ed016603c

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
