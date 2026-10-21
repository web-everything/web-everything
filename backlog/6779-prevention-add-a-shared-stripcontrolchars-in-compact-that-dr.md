---
bornAs: xriya6i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/operator-why.mjs", "we:scripts/operations/operator-controls.mjs", "we:scripts/operations/__tests__/operator-why.test.mjs", "we:scripts/operations/__tests__/operator-controls.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a shared stripControlChars in compact() that drops C0/C1/ESC and U+2028/9, plus a regression… (from web-everything/web-everything#5169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/operator-why.mjs:10` — Add a shared `stripControlChars` in `compact()` that drops C0/C1/ESC and U+2028/9, plus a regression test with an ESC/OSC payload. A check-standards rule could flag raw `.line` interpolation into CLI screens.
2. `we:scripts/operations/operator-controls.mjs:13` — Verify `gh api user --jq .login` equals `--actor` (case-insensitive) before any apply, as one shared guard for all controls. Record the unverified identity as such in the doc until that lands.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5169@29d3d72f8e6129cf7339d9fe96af64c84c82343f

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
