---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Match the specifier that failed (compare against error.url or parse the quoted path), and add a t… (from web-everything/web-everything#7267 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-slots.mjs:40` — Match the specifier that failed (compare against error.url or parse the quoted path), and add a test with a stub policy-cascade whose dependency is missing that expects exit 1.
2. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:36` — Add a table-driven case, with a CLI case through WE_PLATFORM_PREFERENCES_FILE, that feeds operator hosts values 0, 129, 1.5 and '8' and asserts exit 1.
3. `we:scripts/readiness/forge-slots.mjs:40` — Match the specifier that failed to resolve: compare error.url or the quoted path in the message to the resolved policy-cascade URL, and rethrow otherwise. Add a test for each branch.
4. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:1` — Make operatorLayer() take an injectable importer so the 'module not found' and 'other import error' paths can be unit-tested. A check that every catch branch in readiness scripts has a named test would make this a deterministic gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7267@1de1c05da22afa8c0cac6da1b701e283929b5072

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
