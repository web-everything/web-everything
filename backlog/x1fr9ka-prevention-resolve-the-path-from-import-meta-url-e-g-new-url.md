---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/lib.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Resolve the path from import.meta.url, e.g. new URL('we:./daemon.mjs', import.meta.url). A lint rule agai… (from plateauapp/plateau-app#213 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/lib.test.mjs:1974` — Resolve the path from import.meta.url, e.g. new URL('we:./daemon.mjs', import.meta.url). A lint rule against cwd-relative fs reads in tests would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#213@a1391019cd186b32fe27e4ecaf63c9d066a101a5

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
