---
bornAs: xf8qq9s
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-prestage.mjs", "we:scripts/lib/__tests__/drain-prestage.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a CLI test with the freeze enabled. More broadly, a lint or test-fixture rule that fails when… (from web-everything/web-everything#5480 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5013` — Add a CLI test with the freeze enabled. More broadly, a lint or test-fixture rule that fails when every test of a new entry point passes a `--no-<gate>` bypass flag.
2. `we:scripts/lib/drain-prestage.mjs:96` — Exclude the drain-owned ci-lifecycle labels (`checking`, `ci:failed`, `blocked`) from `labelSignature`. Add a CLI test where the fake gh applies label edits and `checking` is present at prepare time and absent at green time.
3. `we:scripts/merge-ai-prs.mjs:5016` — Add a CLI test in we:merge-ai-prs-prestage.test.mjs that leaves the freeze check on, sets a manual freeze or red-main state, and asserts a green event writes no enqueuePullRequest call and falls back. A source-contract assertion that the shortcut references readDrainFreezePass and decideRedMainHold would also help. More generally, a lint or check:standards rule could require each pass-level hold in sweepOnce to appear in a test that does not bypass it.
4. `we:scripts/lib/__tests__/drain-prestage.test.mjs` — Add a separate deterministic disabling regression with a fresh eligible cache and green checks, proving that disabling alone prevents reads and enqueue.
5. `we:scripts/lib/__tests__/drain-prestage.test.mjs` — Add independent regression tests using a fresh, green eligible entry with preparation disabled, and a nondefault TTL with assertions immediately before and at expiration; require mutations removing the enable guard or hardcoding the TTL to fail those tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5480@cc896d30e430f156f88eef0251d358fe14f88fd6

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
