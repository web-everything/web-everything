---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/guard-git-push.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/__tests__/guard-git-push.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a dirty-tracked-file case to the pinned release --discard test matrix, and a test that assert… (from web-everything/web-everything#7208 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:3688` — Add a dirty-tracked-file case to the pinned release --discard test matrix, and a test that asserts discard release leaves the worktree equal to origin/main.
2. `we:scripts/guard-git-push.mjs:72` — Export one `isPinnedLease(lease)` helper from we:scripts/lib/lane-lease.mjs, use it in both places, and add a unit test over {at only, branch only, both, neither}.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7208@079ee761603ca2cfec5c13c759c8840356edbcb1

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
