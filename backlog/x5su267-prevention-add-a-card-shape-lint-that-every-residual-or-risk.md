---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/8676-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md", "we:backlog/8649-isolate-confined-agy-logs-from-unsandboxed-sessions.md", "we:backlog/8659-prove-detached-agy-descendants-cannot-outlive-successful-evi.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a card-shape lint that every residual or risk enumerated in a card body maps to a named test… (from web-everything/web-everything#7291 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/8676-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md:19` — Add a card-shape lint that every residual or risk enumerated in a card body maps to a named test (a residual-to-A-line mapping check). Alternatively, add a review lens for it.
2. `we:backlog/8649-isolate-confined-agy-logs-from-unsandboxed-sessions.md:14` — Add a check:item rule that every '#NNNN' card reference in a backlog body resolves to an existing backlog file or a known PR.
3. `we:backlog/8659-prove-detached-agy-descendants-cannot-outlive-successful-evi.md:21` — Require every [An] bullet in a security-tagged card to name a backticked test case or a runnable command, and enforce that in check:item.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5039, finding 4 → #5039.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7291@cc5f7a4e4a70004a8735eea2a2c8b2e7dfaad5f6

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
