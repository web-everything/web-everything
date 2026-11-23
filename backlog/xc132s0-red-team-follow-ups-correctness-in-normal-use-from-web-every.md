---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7361 (head 76fa81732)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7361 (reviewed head `76fa81732624dc16606718212c59d87ac29f45d8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/hotpatch-readers.mjs:80` — (failing-input, degraded) Valid full-suite receipts are rejected when quarantine skips no tests
   - Scenario: Run otherwise successful full CI with redMainMode=quarantine and no live quarantine entries. The quarantine helper skips nothing and logs 'red-main-quarantine skip: no live quarantine entry'. Because this lacks 'running everything', fullSuite returns false and admission returns unknown/hotpatch-full-suite-unproven despite green checks and a valid own-sha audit. These zero-skip executions should qualify as full-suite receipts. The helper's 'main runs every test' and main-fix PR messages are rejected similarly.
   - Class: correctness-in-normal-use (basis: A read-only Node probe executed production decideCiSkip with quarantine mode, an empty entry list and a known PR context. It returned skip=[] and 'no live quarantine entry'; applying the reader's exact predicate rejected that output. The receiptGuard call site maps this rejection to unknown. This requires ordinary supported configuration, with no attacker or concurrency assumptions.)
   - Claude's re-check: demonstrated break

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
