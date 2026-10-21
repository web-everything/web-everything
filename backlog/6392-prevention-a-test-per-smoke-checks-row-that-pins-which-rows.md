---
bornAs: xcuqqvs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild-smoke-cache.test.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — A test per SMOKE_CHECKS row that pins which rows the changed-files path skips for a given diff, s… (from web-everything/web-everything#5456 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-live-smoke.mjs:882` — A test per SMOKE_CHECKS row that pins which rows the changed-files path skips for a given diff, so a change in skip semantics fails loudly instead of being fixed by rewriting counts.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:660` — Parametrise the existing environment-verdict tests over reused and fresh results, so any new early exit has to match the classifiers' outputs.
3. `we:scripts/lib/daemon-rebuild/smoke.mjs:40` — Add a shared parser for boolean env overrides in the policy cascade that treats unrecognised values as invalid and logs them. A check:standards rule would flag hand-rolled `=== '0' ? false : === '1' ? true : undefined` ternaries.
4. `we:scripts/lib/__tests__/daemon-rebuild-smoke-cache.test.mjs:262` — Update the parameterized test to assert reuseCode is false, and add a deterministic mutation check that accepting a mismatched proof makes this named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5456@d288aaec8ac285d0d1cd6f23ecbcae1a37b8ec1c

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
