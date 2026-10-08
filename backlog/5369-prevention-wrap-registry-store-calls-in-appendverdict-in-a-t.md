---
bornAs: xj4sdcb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Wrap registry-store calls in appendVerdict in a try/catch that maps a throw to a miss, and add a… (from web-everything/web-everything#4401 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:1181` — Wrap registry-store calls in appendVerdict in a try/catch that maps a throw to a miss, and add a registry test with a throwing store. A deterministic option is to have registerLedgerStore wrap append and read so throws become ok:false / unreadable.
2. `we:scripts/lib/verdict-ledger.mjs:1385` — Add a conformance case that runs `read` with undefined, blank and malformed `repo` and with negative and non-integer `from`. Validate `range` in a shared `checkLedgerReadRange` helper next to `checkLedgerAppendRows`, so every adapter inherits it.
3. `we:scripts/lib/verdict-ledger.mjs:1180` — Wrap registry-store calls in one adapter that converts a throw or malformed result into `{ok:false, appended:0, error}`, and test it with a throwing fake store. Have `registerLedgerStore` refuse to replace an existing name unless asked explicitly.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4401@35c509bcbe408f337fa59b3d1dfd12feb7d8a216

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
