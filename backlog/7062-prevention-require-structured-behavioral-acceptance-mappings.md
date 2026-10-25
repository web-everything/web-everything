---
bornAs: xhbjl53
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xe63fd8-prevention-add-a-test-that-starts-with-red-team-blocked-and.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Require structured behavioral acceptance mappings with a qualified test file, explicit case name,… (from web-everything/web-everything#5908 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/7057-prevention-add-a-test-that-starts-with-red-team-blocked-and.md:15` — Require structured behavioral acceptance mappings with a qualified test file, explicit case name, and concrete expected output; deterministically reject missing mappings and review whether the expected output resolves the behavioral decision.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5908@13f0efb0a38774fd1e2e6b2ffcd33ff2f6ddf8be

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
