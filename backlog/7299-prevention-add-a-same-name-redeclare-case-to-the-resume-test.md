---
bornAs: xl3awwv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-item-tasks.mjs", "we:scripts/lib/__tests__/daemon-item-tasks.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a same-name-redeclare case to the resume test. More generally, run mutation checks on prose-p… (from web-everything/web-everything#5934 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-item-tasks.mjs:288` — Add a same-name-redeclare case to the resume test. More generally, run mutation checks on prose-promised invariants in the PR gate.
2. `we:scripts/lib/daemon-item-tasks.mjs:284` — Add a cross-attempt test where attempt N+1 starts with a prior applied effect and its probe throws if called.
3. `we:scripts/lib/daemon-item-tasks.mjs:365` — Add a harness test with a throwing `timing` sink and a throwing result `update`. Longer term, add a check:standards lint that flags 'never/cannot' prose in comments with no matching `it(` name.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5934@2e3a2471214bd38c0d27a016015f49cba4a380e7

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
