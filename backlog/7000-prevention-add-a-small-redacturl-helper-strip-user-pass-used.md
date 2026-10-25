---
bornAs: xv8okiw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a small redactUrl helper (strip user:pass@) used for any URL that reaches the result JSON or… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/codex-job.mjs:1` — Add a small `redactUrl` helper (strip `user:pass@`) used for any URL that reaches the result JSON or logs, with a test using a credentialed origin. A standards rule flagging raw `originUrl` in output paths would make this deterministic.
2. `we:scripts/operations/__tests__/codex-job.test.mjs` — Add a deterministic regression test with a destination leaf symlink pointing to a sentinel; assert the sentinel remains unchanged and publication stages the expected regular-file bytes and mode.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #6964.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@962b8ac59d5357740a2ac42fe1c9e928145353c3

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
