---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a drifted-line ignoredRulings unit test with an earlier-head operator ruling carrying superse… (from web-everything/web-everything#4430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ruling-ledger.mjs:224` — Add a drifted-line `ignoredRulings` unit test with an earlier-head operator ruling carrying `supersedes`. The mutation probe on the `supersedes.includes` clause should redden it.
2. `we:scripts/operations/record-referral-ruling.mjs:214` — Restrict auto-supersede to an explicit `<file>:<line>` or key selector and require `--supersedes` for `all-open`. Add a test using the multi-finding #4271 fixture with `finding: 'all-open'` and disputed present.
3. `we:scripts/lib/ruling-ledger.mjs:223` — In `overruled`, require both the id match and sameFindingForClearing (or a stored finding binding), and add a cross-finding supersede negative test.
4. `we:scripts/operations/record-referral-ruling.mjs:110` — Aggregate disputed targets by runId/key and union their blockIds, rulingIds, and standing rulings; add a deterministic regression test with two historical blocks matching one current referral. This guard needs a future backlog filing.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4430@8a8d5c45ae905f7d8e11ec77b51126ec90f8392c

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
