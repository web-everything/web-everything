---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-capacity.mjs", "we:scripts/settings/provider-capacity.json", "we:scripts/lib/__tests__/dispatch-routing-policy-io.test.mjs", "we:scripts/lib/__tests__/provider-capacity.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test that feeds the shipped PROVIDER_DEFAULTS expansion (codex plus codex-alt) through burn… (from web-everything/web-everything#7169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-capacity.mjs:186` — Add a test that feeds the shipped PROVIDER_DEFAULTS expansion (codex plus codex-alt) through burnWindows and recordCapacityDecision and asserts one event per physical window. Better, have readProviderCapacity strip bankedResets and mark aliases `quotaOf` so every consumer sees the same exemption.
2. `we:scripts/lib/provider-capacity.mjs:60` — Add a table test over each timestamp source (at, asOf, mtime, none) crossed with fresh and stale. A mutation probe on the fallback chain would also catch it.
3. `we:scripts/settings/provider-capacity.json:150` — Add the inactive account to the shipped config, or drop the claim from the description.
4. `we:scripts/lib/__tests__/dispatch-routing-policy-io.test.mjs:69` — Add a gate test that iterates every `fix:*` entry in `we:dispatch-routing-policy.json` with a `provider` pin and asserts `resolveDispatchRoute` returns that provider when capacity scores another provider best. A new pin is then covered automatically.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7169@ef0642f780c248293e100dbf6955764b39af52d0

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
