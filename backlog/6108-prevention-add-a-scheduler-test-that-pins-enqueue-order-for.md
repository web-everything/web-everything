---
bornAs: xzcabdx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-concurrency.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/drain-concurrency.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a scheduler test that pins enqueue order for a prioritized candidate. Alternatively, make a m… (from web-everything/web-everything#5251 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6279` — Add a scheduler test that pins enqueue order for a prioritized candidate. Alternatively, make a main-fix or P0 candidate a serial barrier in canParallelEnqueue.
2. `we:scripts/lib/drain-concurrency.mjs:18` — Run the tree validations in a cheap check on the bypass path, or add a test asserting the bypass is behaviour-equivalent for refusal cases. Document the dropped checks explicitly.
3. `we:scripts/lib/drain-concurrency.mjs:18` — Add a test that runs the real parallel enqueue path, or the bypass predicate with a fixture tree containing a tracked symlink and no hash cards. It should assert that the PR is still refused at concurrency 1 and at concurrency 3. Alternatively, move the tree-safety check into a separate function that both paths always call.
4. `we:scripts/merge-ai-prs.mjs:6283` — Add a deterministic live-drain integration test with numbering-required candidates and instrumented preparation, asserting zero overlap; verify that removing the live numbering guard makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5251@d5d876ae3636e8ad45c69cfe5916ef9094d54104

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
