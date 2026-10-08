---
bornAs: xa1hqx0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs", "we:scripts/__tests__/lane-drain.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Compare the frontmatter with bornAs ignored as well, and hold on any difference. Add a drain test… (from web-everything/web-everything#4372 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-drain.mjs:940` — Compare the frontmatter with `bornAs` ignored as well, and hold on any difference. Add a drain test for a frontmatter-only divergence.
2. `we:scripts/operations/open-pr-io.mjs:137` — Derive the branch from `arg('ref')` (or `branch`), and assert in the runner test that `dupBornAs` receives the branch.
3. `we:scripts/lib/__tests__/duplicate-bornas-added.test.mjs:16` — Use a valid 7-character hash (`xnew001`) in the test. Better, give the fresh-hash case a populated `mainBornAs` holding other hashes so it exercises the lookup.
4. `we:scripts/operations/open-pr-io.mjs:110` — Add a deterministic test that injects spawn, omits dupBornAs, and asserts that no duplicate-check git/gh subprocess executes; verify that removing the spawn guard makes that test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4372@eb178b609bec9d05f023e339740ee1beaaf143ce

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
