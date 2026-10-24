---
bornAs: xnodj86
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/graduate-chain.mjs", "we:scripts/operations/__tests__/graduate-chain.test.mjs", "we:scripts/operations/graduate-chain-io.mjs", "we:scripts/operations/__tests__/graduate-chain-io.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — Add boundary tests (cap-1, cap, cap+1) for each cap in we:scripts/operations/__tests__/graduate-c… (from web-everything/web-everything#5840 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/graduate-chain.mjs:78` — Add boundary tests (cap-1, cap, cap+1) for each cap in we:scripts/operations/__tests__/graduate-chain.test.mjs; a shared cap-check helper would make both caps use one operator.
2. `we:scripts/operations/graduate-chain.mjs:139` — Have the release test assert the `--session=` argument, and gate release on a fully validated lease object.
3. `we:scripts/operations/graduate-chain.mjs:93` — Add boundary-pair tests (n=max-1 passes, n=max and n=max+1 stop) for every cap; consider a shared `overCap(count, max)` helper so the two caps cannot diverge.
4. `we:scripts/operations/__tests__/graduate-chain.test.mjs:1` — Add a test that iterates all recorded `gh pr` calls and asserts a `--repo` argument. A lint rule for `gh` calls in scripts/operations would catch the same class.
5. `we:scripts/operations/__tests__/graduate-chain.test.mjs:96` — Seed the fixture env with `WE_BUILD_FINAL_GATE` and assert whether it is forwarded, so the test states the intended contract.
6. `we:scripts/operations/graduate-chain-io.mjs:23` — Restrict `readTemplate` to paths that resolve inside the repo (or a templates dir) and add a traversal-refusal test; file a card for IO-shell path-containment as a standards rule.
7. `we:scripts/operations/graduate-chain-io.mjs:16` — Add a deterministic test asserting timeout and maxBuffer on the production spawn boundary.
8. `we:scripts/operations/graduate-chain.mjs:20` — Add a parameterized test asserting size-unreadable for missing count and path fields.
9. `we:scripts/operations/__tests__/graduate-chain.test.mjs:37` — Return a distinct repository name from the fixture and assert that both PR list and stacked PR view receive it through --repo.
10. `we:scripts/operations/graduate-chain.mjs:77` — Add a deterministic boundary test requiring refusal at exactly repoMax and permitting admission at repoMax minus one.
11. `we:scripts/operations/__tests__/graduate-chain.test.mjs:116` — Give main and the stack head distinct SHAs in the named stacking test and assert that both merge-tree and reset use the stack-head SHA.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5840@88b150f45d3b01fc9866446a95a8c9b8cb007d27

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
