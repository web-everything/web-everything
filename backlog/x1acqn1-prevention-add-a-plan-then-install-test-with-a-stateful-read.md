---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/build-priority-set-io.mjs", "we:scripts/operations/__tests__/build-priority-set-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a plan-then-install test with a stateful readPrs stub that returns different results per call… (from web-everything/web-everything#7268 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/build-priority-set-io.mjs:98` — Add a plan-then-install test with a stateful readPrs stub that returns different results per call, and assert the call count is 2 on install. A review-lens note would also work: every 'fresh/re-read under lock' comment needs a stateful-stub test.
2. `we:scripts/operations/build-priority-set-io.mjs:18` — Run the real-repo test through the default reader, for example by exposing a ROOT override. Alternatively, assert on the options the default closure passes to execFileSync.
3. `we:scripts/operations/build-priority-set-io.mjs:44` — Add a fixture-based test that pins the real `gh pr list --json files` shape, or use a contract test that fails when an evidence-reader field is not in the recorded schema.
4. `we:scripts/operations/build-priority-set-io.mjs:98` — Add a lint or test convention that every write op with a post-commit step asserts its outcome state, and write a 'committed' audit phase after the rename.
5. `we:scripts/operations/build-priority-set-io.mjs:18` — Check the age of the origin/main ref (fetch-head mtime) and refuse past a threshold, with a test pinning the refusal.
6. `(no file cited)` — Require each acceptance clause to reference a named implemented or explicitly planned test with observable assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7268@ac95f9c7f7a119c12eff43be974cc1f8d11a4b1d

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
