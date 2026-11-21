---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a unit test on summarizeRun or settleKind with the #7202 fixture, expecting kind 'accept' and… (from web-everything/web-everything#7276 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-red-team-evidence.mjs:317` — Add a unit test on `summarizeRun` or `settleKind` with the #7202 fixture, expecting kind 'accept' and a still-held non-accept shape. A cheap gate would be to require that every call site of the shared predicate has a named test.
2. `we:scripts/lib/drain-red-team-evidence.mjs:273` — Add a table-driven positive test over `ACCEPT_VERDICTS`. Better, export that list and have the test iterate it, so a new accept-class verdict is covered automatically.
3. `we:scripts/lib/drain-red-team-evidence.mjs:273` — Have trailingLedgerOnly reuse the single ACCEPT_VERDICTS constant, and add a parametrised test over every ACCEPT_VERDICTS entry. This cannot be a lint rule, because it is a duplicated-constant problem; the nearest gate is a review lens.
4. `we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs:1188` — Add a table-driven named regression covering unknown nonempty verdict strings, and require it to fail when the verdict allowlist is bypassed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7276@77e0085a04e58cc2e098d702f650b1da6c9583cd

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
