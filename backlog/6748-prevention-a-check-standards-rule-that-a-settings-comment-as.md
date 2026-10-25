---
bornAs: xlgn7mo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/settings/ledger.json", "we:scripts/lib/__tests__/ledger-observation.test.mjs", "we:backlog/xjdyood-prevention-enforce-ledger-observer-and-writer-test-contracts.md", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/ledger-observation.mjs", "we:scripts/lib/verdict-ledger.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A check:standards rule that a settings comment asserting a guarantee must cite a test. Alternativ… (from web-everything/web-everything#5492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/settings/ledger.json:2` — A check:standards rule that a settings `$comment` asserting a guarantee must cite a test. Alternatively, add the live-head reader test to the matrix.
2. `we:scripts/lib/__tests__/ledger-observation.test.mjs:200` — A test-plan convention: a change that removes a hold reason must assert that a remaining hold or `clears:false` still applies. Backfill's `shadowRow` test should assert `wouldClear` is false.
3. `we:backlog/xjdyood-prevention-enforce-ledger-observer-and-writer-test-contracts.md:19` — A backlog lint requiring a Test plan entry (test file plus case name) for each Acceptance item before a card may be filed as open.
4. `we:scripts/merge-ai-prs.mjs:6230` — Add a per-pass observation budget or circuit breaker to the drain loop. Add a test with a failing transport that asserts the pass completes within the budget.
5. `we:scripts/lib/ledger-observation.mjs:94` — A shared `assertPrNumber` / `assertRepoSlug` helper at gh-wrapper boundaries, enforced by a standards rule against raw interpolation of event fields into argv.
6. `we:scripts/lib/verdict-ledger.mjs:491` — Validate optional lifecycle fields symmetrically (type and length) in `validateVerdictRecord`, with a table-driven test over every optional field.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5492@fbb55e26425d3e95f023b17fee1e51212f9b154d

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
