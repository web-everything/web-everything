---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add tests in we:jury-core.test.mjs next to 'a later snapshot that %s is malformed': 'a later snap… (from web-everything/web-everything#5849 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:3746` — Add tests in we:jury-core.test.mjs next to 'a later snapshot that %s is malformed': 'a later snapshot may APPEND a referral' and rows for 'rewrites/drops/reorders a referral'.
2. `we:scripts/operations/review-pr-io.mjs:1235` — Add a sink test asserting the judge is not called (and the cap is not consumed) when there are no operator rulings on the head or only target-vs-target candidates. Restrict pair generation to ruled×target.
3. `we:scripts/lib/jury-core.mjs` — Add tests to we:jury-core.test.mjs for append-only referrals across snapshots: rewrite, reorder and drop of a prior referral each yield `malformed`, and a pure append is accepted. Longer term, a standards rule that every new 'cannot X' comment in we:scripts/lib/jury-core.mjs names its test.
4. `we:scripts/lib/jury-core.mjs` — File a card to bind judge decisions to a signed or recomputed provenance. That could be a judge-run id the gate can check, or a rule that a judge-merged carry only counts when a second seat concurs.
5. `we:scripts/operations/review-pr-io.mjs:1238` — Add a deterministic sink test asserting that captured output excludes an injected model-generated reason.
6. `we:scripts/lib/jury-core.mjs:3189` — Add a deterministic regression test distinguishing single-space and double-space string literals through matching and serialized carry validation.
7. `we:scripts/lib/jury-core.mjs:3746` — Add a table-driven reader regression test covering append, removal, reorder, and rewrite transitions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5849@9a5d650acd5cfc32b4060cebf10c828dec01cf7b

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
