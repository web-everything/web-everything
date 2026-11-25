---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/daemon-host-gate.mjs", "we:scripts/operations/__tests__/daemon-host-gate.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — A swap test that asserts the exact signal list each slot receives for each wrapper signal, before… (from web-everything/web-everything#7503 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/daemon-host-gate.mjs:340` — A swap test that asserts the exact signal list each slot receives for each wrapper signal, before escalation.
2. `we:scripts/operations/daemon-host-gate.mjs:416` — Run the existing watch-loop contract tests (completion, revocation, shutdown) with both swap off and swap on.
3. `we:scripts/operations/daemon-host-gate.mjs:454` — Add a test with deferred readiness where the green leader exits before readiness resolves true; a changed-line mutation check would catch this class.
4. `we:scripts/operations/daemon-host-gate.mjs:443` — Parameterize the cleanup-failure test over every exit path that stops a candidate.
5. `we:scripts/operations/daemon-host-gate.mjs:536` — Add a truthy non-true `greenCapable` case and a two-promotion test asserting WE_DAEMON_GEN.
6. `we:scripts/operations/daemon-host-gate.mjs:373` — Add a swap-on test that revokes ownership, restores it, and asserts a fresh blue is spawned. As a class guard, file a diff-scoped mutation check over daemon supervisor return and guard branches.
7. `we:scripts/operations/daemon-host-gate.mjs:404` — Extend the 'refreshes ownership and refuses an existing candidate' test with a variant whose candidate group probe throws EPERM, asserting result 1. The same filed diff-scoped mutation check covers the class.
8. `we:scripts/operations/daemon-host-gate.mjs:528` — Add an it.each over 1, 'false', {} and a Promise for greenCapable asserting a single non-swap spawn with no env, mirroring the existing 'truthy non-true readiness' test.
9. `we:scripts/operations/daemon-host-gate.mjs:334` — Record an absolute deadline before invoking validation, check it before promotion, and race ownership reads against cancellation; add a deterministic named regression test 'synchronous readiness exceeding deadline refuses promotion' using an injected clock.
10. `we:scripts/operations/daemon-host-gate.mjs:412` — Refresh ownership after readiness resolves and recheck candidate liveness, shutdown, and deadline before transferring markers; add a deterministic named regression test 'ownership revoked during readiness prevents promotion' asserting no promotion and candidate termination.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7503@41dd8adb719fb47c1e8b776c14920c8744692797

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
