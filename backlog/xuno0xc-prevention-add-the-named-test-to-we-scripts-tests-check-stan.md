---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add the named test to we:scripts/__tests__/check-standards.test.ts, deterministically injecting EACCES at… (from frontier-ui/frontierui#59 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:61` — Add the named test to we:scripts/__tests__/check-standards.test.ts, deterministically injecting EACCES at the sibling-root stat and asserting exit 1, the error diagnostic, and no skip warning.
2. `we:scripts/check-standards.mjs:59` — Add the two fixtures (WE_ROOT as a file, WE_ROOT unreadable). A coverage threshold on we:scripts/check-standards.mjs branches would catch this class of gap deterministically.
3. `we:scripts/check-standards.mjs:78` — Add a check:standards or unit test pinning KNOWN_UNRESOLVED to a frozen snapshot of ids (or a max length), so additions require editing a test. Move the list to a data file to make this possible.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#59@8e868e897cf4aea32f80dfe4acf2bf2534969e85

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
