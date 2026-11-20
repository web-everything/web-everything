---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/author-stamp-restore.mjs", "we:scripts/lib/__tests__/author-stamp-restore.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a Tier 1 test that a bracketed one-line link with no marker still takes the same path as base… (from web-everything/web-everything#7231 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/author-stamp-restore.mjs:110` — Add a Tier 1 test that a bracketed one-line link with no marker still takes the same path as base. Or delete the `bracketed` expression and keep only `linkMayEnclose`. A coverage-mutation gate over `we:scripts/lib/author-stamp-restore.mjs` would catch dead predicates.
2. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:944` — Add an `it.each` of allowed machine comments (including `policy-set: x.y`) and near-miss comments that must refuse. A mutation-testing step on the regex literals would also catch this.
3. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:943` — Add a table-driven negative test for each allowlisted marker pattern (anchor, charset and trailing-tail variants). Then add a standards rule that every regex allowlist in `scripts/lib/*-restore*.mjs` has a paired near-miss test.
4. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:949` — Add a CI regression test containing the described link, machine comments, placeholder, and historical stamp together, asserting restoration of the expected actor ID.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7231@680ab960adddc9edb79b33fa4f9643298f10ae2c

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
