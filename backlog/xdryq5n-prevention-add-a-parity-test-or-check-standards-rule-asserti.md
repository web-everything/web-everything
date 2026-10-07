---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/dispatch-settings.json"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a parity test or check:standards rule asserting resolveHeavyAdmissionCap({env:{}}) equals we:… (from web-everything/web-everything#4306 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/dispatch-settings.json:2` — Add a parity test or check:standards rule asserting resolveHeavyAdmissionCap({env:{}}) equals we:heavy-admission.mjs resolveCap({}) and we:vitest.shared.ts's default. Alternatively, make we:heavy-admission.mjs resolveCap fall back to resolveHeavyAdmissionCap so there is a single source of truth.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4306@c21b43174c3527e333bda5bd94f349990953a7cd

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
