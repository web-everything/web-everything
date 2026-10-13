---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/renamed-pr-refresh.mjs", "we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lib/__tests__/renamed-pr-refresh.test.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Have the enrichers fail closed: require pr.isCrossRepository === false and fetch it per PR when a… (from web-everything/web-everything#5082 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/renamed-pr-refresh.mjs:21` — Have the enrichers fail closed: require `pr.isCrossRepository === false` and fetch it per PR when absent. Alternatively, add a contract test that builds fixtures from the real listing field constants.
2. `we:scripts/lib/queue-branch-numbering.mjs:17` — Authenticate the drain commits with a pinned allowlist in a settings file, or with GitHub commit verification (signature or `verification.verified`). Add a test that copies the allowlisted identity verbatim and asserts the pair is not exempted.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5082@a1c8cddd4f808d28b935531b59357c903c059f0b

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
