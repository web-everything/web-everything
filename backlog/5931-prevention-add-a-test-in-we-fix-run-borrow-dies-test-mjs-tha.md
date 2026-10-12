---
bornAs: xef5raq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a test in we:fix-run-borrow-dies.test.mjs that runs a non-borrowed codex fix-run and asserts… (from web-everything/web-everything#4984 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:454` — Add a test in we:fix-run-borrow-dies.test.mjs that runs a non-borrowed codex fix-run and asserts recordBorrowOutcome (the borrow ledger) is not written. Alternatively, have recordBorrowOutcome read the claim's meta.borrowed and no-op otherwise.
2. `we:scripts/operations/fix-run.mjs:560` — Run every launcher git call in the agent-writable lane with `-c diff.ignoreSubmodules=all`, `status.submoduleSummary=false` and `--ignore-submodules=all`, or refuse a lane index that contains a 160000 entry. Add a check:standards rule that any `git` call in we:scripts/operations/fix-run.mjs goes through the hardened wrapper, and a real-git test with a planted submodule filter.
3. `we:scripts/operations/fix-run.mjs` — Add a deterministic parameterized regression test for valid branch names containing '+' and Unicode, alongside the existing option-injection rejection test; rely on Git's validation after rejecting option-like input.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4984@8ebe0abca4d27d6df9a5d19be5176baa62fdb0ef

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
