---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:backlog/7054-lane-pool-review-prevention-and-follow-ups.md", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Reject pool names containing path separators or .. once, at flag parse, so every derived path is… (from web-everything/web-everything#5859 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lane-pool.mjs:385` — Reject pool names containing path separators or `..` once, at flag parse, so every derived path is covered. A lint on `join(..., flags.pool)` would catch the class.
2. `we:scripts/lane-pool.mjs:3862` — Export one `cleanForLog` from the lane-pool lib, and add a check:standards rule that bans logging raw `entry.name` or `readdir` names.
3. `we:backlog/7054-lane-pool-review-prevention-and-follow-ups.md:15` — The `check:standards` rule already specced as 7054 A1: tests that spawn lane-pool acquire/release must set the recovery policy explicitly. It is not built yet.
4. `we:backlog/7054-lane-pool-review-prevention-and-follow-ups.md:43` — Add a deterministic backlog lint rule requiring each behavioral risk mapping to specify a repository-qualified test file, named case, and observable expected result.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5859@b5b1b9b7d19aba0f29d7e69aef5c14ab524e4504

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
