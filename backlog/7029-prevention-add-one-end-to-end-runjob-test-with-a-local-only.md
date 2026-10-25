---
bornAs: xfjfr8t
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add one end-to-end runJob test with a local-only base. Or have resetLane reject any base that doe… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/codex-job.mjs:207` — Add one end-to-end runJob test with a local-only base. Or have resetLane reject any base that does not resolve under origin/, so the two paths cannot diverge.
2. `we:scripts/operations/__tests__/codex-job.test.mjs:22` — Add a case with origin `file:/lane/gitconfig` at global scope, and have the test list each guard independently.
3. `we:scripts/operations/codex-job.mjs` — Add a `redactUrl()` helper that strips userinfo, and use it in `plan()` and every `s.io.log` or result string. Add a test asserting that a userinfo-bearing origin never appears in the dry-run JSON. Better still, refuse an origin that contains userinfo.
4. `we:scripts/operations/codex-job.mjs` — Write task files to the `mkdtemp` directory outside the lane, or use `flag: 'wx'` with a random name via `randomUUID()`, and add a test that a pre-existing path is refused.
5. `we:scripts/operations/codex-job.mjs` — Add a deterministic concurrent-creation regression test and enforce an atomic expected-absent condition on the destination ref.
6. `we:scripts/operations/__tests__/codex-job.test.mjs` — Add a deterministic real-filesystem regression test for leaf symlink replacement to the publication test suite.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #6964, finding 6 → #7014.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@cbee44ac0f4577df407632f161e09e24c30097d2

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
