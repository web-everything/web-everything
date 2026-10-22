---
bornAs: xv4gpm6
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/conveyor/soak/breaks/argon-feature-dispatch.mjs", "we:scripts/lib/provider-routing.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/argon-feature-dispatch.test.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a table-driven test over (route provider, held key) pairs for resolveOperationRoute's availab… (from web-everything/web-everything#5370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/dispatch-routing-policy.mjs:107` — Add a table-driven test over (route provider, held key) pairs for resolveOperationRoute's availability filter. A coverage-threshold gate on branch coverage for we:scripts/lib/dispatch-routing-policy.mjs would catch a similar omission.
2. `we:scripts/conveyor/soak/breaks/argon-feature-dispatch.mjs:13` — Add a we:breaks-shape.mjs rule that rejects a non-hex `fixedBy.sha` once the file is on main. Alternatively, allow an explicit 'uncommitted' sentinel, which other breaks already use.
3. `we:scripts/lib/provider-routing.mjs:363` — Add a test, or a contract check on `probationWorkerForRoute`, that asserts every path producing an `antigravity-argon` worker consults `readBuildArgonSettings().enabled`. Alternatively, apply the enabled check inside `probationWorkerForRoute` and `probationLaunchDecision`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5370@fd1c489501d0b38667500db69fae81a8e7e618c8

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
