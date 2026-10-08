---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-note-comment.mjs", "we:scripts/lib/pr-comment-policy.mjs", "we:scripts/conveyor/__tests__/reconcile-note-comment.test.mjs", "we:scripts/lib/__tests__/pr-comment-policy.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a unit test that calls planNoteComment without options under a stubbed env. More generally, r… (from web-everything/web-everything#4494 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-note-comment.mjs:186` — Add a unit test that calls planNoteComment without options under a stubbed env. More generally, review lens: for each setting, require one test that flips it through the real default path.
2. `we:scripts/lib/pr-comment-policy.mjs:77` — Add a deterministic policy test requiring every implemented suppression reason to have a positive integration case using an eligible production note kind; defer branches that cannot satisfy it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4494@0346204872abbf2baf414cdf4b6540cda65d948c

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
