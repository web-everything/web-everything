---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a test that seeds a proof, then returns each environment verdict (auth-broken, env-timeout, e… (from web-everything/web-everything#5456 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:664` — Add a test that seeds a proof, then returns each environment verdict (auth-broken, env-timeout, env-unavailable, transient) from the reused smoke. It should assert the classifier-specific alert and reason, and that `rejected` stays unset. Better still, route the reused path through the classifier loop and skip only the rejection and fallback steps.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:40` — Hash the whole harness import closure of `we:daemon-live-smoke.mjs`, reusing `collectImportClosure`. Alternatively add a check:standards rule that every file imported by the smoke runner feeds `smokePassIdentity`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5456@68cd1be796b426c4d418139e451855f016410ddc

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
