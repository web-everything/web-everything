---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/wip/sessions/sessions-mount.ts", "we:src/wip/sessions/sessions-view.ts", "we:src/main.ts", "we:src/wip/sessions/__tests__/sessions-mount.test.mjs", "we:src/wip/sessions/__tests__/sessions-view.test.mjs", "we:src/__tests__/main.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a mount test that pushes a sessions-less snap on an open live channel and asserts the page does not s… (from plateauapp/plateau-app#216 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/wip/sessions/sessions-mount.ts:115` — Add a mount test that pushes a sessions-less snap on an open live channel and asserts the page does not say "Loading…". A state-matrix test over (live/poll) x (snap/delta/never/error) for the empty-data case would catch the whole class.
2. `we:src/wip/sessions/sessions-view.ts:135` — Run `esc()` on every interpolated value in the renderer and use `transcriptUrl(ref) !== null` as the gate for rendering Copy. A lint or standards rule banning bare `${...}` interpolation in HTML-template renderers would catch the class. Add a hostile-enum / odd-ref test row.
3. `we:src/wip/sessions/sessions-mount.ts:105` — Add a deterministic deferred-promise regression test delivering a newer socket value before resolving an older HTTP request, and gate acceptance by snapshot freshness.
4. `we:src/main.ts:756` — Add a deterministic fake-timer test asserting close is called, the pending request is aborted, and advancing time after cleanup causes no further fetches; add a navigation assertion for the route lifecycle.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#216@6267a693deae200753328d5c07917261e0b865aa

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
