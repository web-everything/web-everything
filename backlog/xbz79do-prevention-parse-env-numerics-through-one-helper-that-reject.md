---
bornAs: xbz79do
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/host-overload-settings.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/lane-pool.mjs", "we:backlog/6409-host-overload-guard-review-follow-ups-policy-bounds-and-admi.md", "we:scripts/lib/__tests__/host-overload-settings.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Parse env numerics through one helper that rejects trim()==='' before Number(), and add a table-d… (from web-everything/web-everything#5624 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/host-overload-settings.mjs:59` — Parse env numerics through one helper that rejects trim()==='' before Number(), and add a table-driven test that feeds '', ' ', and '0x10' to every numeric leaf. A lint or check:standards rule against bare Number(env[...]) in settings readers would catch the whole class.
2. `we:scripts/readiness/heavy-admission.mjs:1129` — A delivery-card template check that every "never/cannot" prose guarantee names a test. This is already scoped as 6409 A5 (per-guarantee test mapping).
3. `we:scripts/lane-pool.mjs:4435` — A write-gate requiring each new CLI subcommand to have a spawn-level test for its refusal branch. This is part of 6409 A5 (refusal-branch coverage).
4. `we:backlog/6409-host-overload-guard-review-follow-ups-policy-bounds-and-admi.md:21` — Make the named overloaded CLI subprocess test a deterministic gate. Follow-up scope is already recorded in A4.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5624@fc45401fedc62e65d3980eeda220a5e4b56ef7df

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
