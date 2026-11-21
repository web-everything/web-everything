---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-capacity-io.mjs", "we:scripts/lib/routing-settings.mjs", "we:scripts/lib/__tests__/provider-capacity-io.test.mjs", "we:scripts/lib/__tests__/routing-settings.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a check:standards rule or table-driven test that every event kind returned by burnWindows has… (from web-everything/web-everything#7169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-capacity-io.mjs:78` — Add a check:standards rule or table-driven test that every event kind returned by `burnWindows` has at least one emission and dedupe assertion.
2. `we:scripts/lib/routing-settings.mjs:68` — Use a lint or review lens that flags a documented 'never throws' contract with no injected-throw test at each call boundary.
3. `we:scripts/lib/provider-capacity-io.mjs:72` — Add a retention or rotation rule for append-only state ledgers, with a gate that requires a size bound on any new `appendFileSync` ledger.
4. `we:scripts/lib/provider-capacity-io.mjs:52` — Add a table-driven security test for untrusted reader specs (absolute, `..`, backslash, empty) next to the reader. A lint rule requiring a test reference for every `isAbsolute`/`..` path guard would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7169@1af36c849a829f5410ed94568b8af32d1e3568af

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
