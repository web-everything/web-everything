---
bornAs: xcb9yti
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/free-scope-io.mjs", "we:scripts/operations/__tests__/free-scope-io-real.test.mjs", "we:scripts/operations/__tests__/free-scope-io.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add to we:scripts/operations/__tests__/free-scope-io-real.test.mjs: (1) after collect, assert the… (from web-everything/web-everything#4525 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/free-scope-io.mjs:88` — Add to `we:scripts/operations/__tests__/free-scope-io-real.test.mjs`: (1) after `collect`, assert the clone has no `.git/FETCH_HEAD` and no `refs/pull/*`; (2) run `collect` with the fetch failing (for example, origin path moved after the first call) and assert that heads already present still give `source: 'git'`.
2. `we:scripts/operations/__tests__/free-scope-io-real.test.mjs:59` — Add a `readNetFileSets` unit test that passes a malformed `headRefOid` and a non-integer `number`. Assert that a recording `git` fake is never called with them and that the result is `{ok:false}`. Longer term, add a standards rule requiring a negative test for every `execFile` argument interpolation.
3. `we:scripts/operations/free-scope-io.mjs:70` — In `defaultGitDirFor`, verify `git remote get-url origin` resolves to `github.com/<repo>`. Return null otherwise, and add a test with a mismatched origin.
4. `we:scripts/operations/free-scope-io.mjs:91` — Add a deterministic regression test with stale main, an available PR head reverting a newer main change, and a failed fetch; assert the affected path remains occupied or the snapshot becomes unknown. Reject stale-base git results unless freshness is established. This guard must be filed; this review could not write a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4525@2e51f43859f44a4aa78b76cc364d7f8179a0ef0f

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
