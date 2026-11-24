---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/daemon-overlay-audit-check.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/__tests__/daemon-overlay-audit-check.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a test matrix that runs every registration entry point (add, add --check, replace, replace --… (from web-everything/web-everything#7369 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/daemon-overlay.mjs:692` — Add a test matrix that runs every registration entry point (add, add --check, replace, replace --check, guardedRegister) against the same override and refusal assertions.
2. `we:scripts/daemon-overlay-audit-check.mjs:28` — Have readOverlayState or main() normalize non-string sha to undefined, with a fixture test for a malformed entry showing the other overlays are still reported.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7369@38c877a8fd55767dd9be3cde73b1c74bf9b16356

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
