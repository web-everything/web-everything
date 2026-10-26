---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/soak/breaks/await-verify-no-op-self-review.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/await-verify-no-op-self-review.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — When a git command gains --porcelain, add a test that feeds the stdout-only rejection through def… (from web-everything/web-everything#5919 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/await-verify-pass.mjs:782` — When a git command gains `--porcelain`, add a test that feeds the stdout-only rejection through `defaultAwaitVerifyIo.push` and asserts the returned `reason` contains the status line. A shared helper that merges stderr and stdout would also prevent the class.
2. `we:scripts/conveyor/await-verify-pass.mjs:802` — Add an end-to-end test through `defaultAwaitVerifyIo.push` using `fakeExec` with a porcelain `=` line. More generally, require a test at each layer boundary where a new result field is added.
3. `we:scripts/conveyor/soak/breaks/await-verify-no-op-self-review.mjs:47` — Assert the release refusal and add a deterministic mutation check requiring this soak to fail when selfReviewReleaseRefusal returns null.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5919@bfab5e7920cfa0704c151d95a3b19cc598505a61

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
