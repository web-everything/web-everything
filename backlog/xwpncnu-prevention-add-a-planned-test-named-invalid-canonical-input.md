---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5960-pass-daemons-self-sync-onto-adopted-code-like-the-other-daem.md"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a planned test named invalid canonical input bypasses legacy compatibility in we:skills-src/c… (from web-everything/web-everything#5392 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5960-pass-daemons-self-sync-onto-adopted-code-like-the-other-daem.md` — Add a planned test named `invalid canonical input bypasses legacy compatibility` in we:skills-src/conveyor/__tests__/pass-daemon.test.mjs. Set a lower policy layer to false, supply an invalid nonblank canonical value, and separately enable each legacy opt-in; assert resolution remains false, reports the lower-layer source, and emits the invalid-value diagnostic. This deterministic regression test should fail if invalid canonical input is routed through legacy compatibility.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5392@4e1a65263c3c0d13a40c22e11b6ab754184c9154

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
