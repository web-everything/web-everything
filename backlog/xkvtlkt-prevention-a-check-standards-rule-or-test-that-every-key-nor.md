---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/conveyor/__tests__/referral-auto-block.test.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — A check:standards rule or test that every key normalizeFinding whitelists is also declared in the… (from web-everything/web-everything#4442 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:408` — A check:standards rule or test that every key normalizeFinding whitelists is also declared in the reviewer output schemas (we:panel-fanout.mjs and we:review-pr.mjs), or is explicitly listed as consumer-only.
2. `we:scripts/conveyor/__tests__/referral-auto-block.test.mjs:206` — Add a test-quality lint or review lens: a test named for a "never X" guarantee must have at least one mutation that turns it red. Alternatively, make the send-back effect take an injectable `runSetLabel` and assert its argv in the same test file.
3. `we:scripts/lib/review-settings.mjs:35` — Add a deterministic configuration matrix test covering missing, valid, and invalid environment overrides against both valid file modes, asserting operator mode for every unknown explicit override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4442@c0ee670d7f329c4d1d1275e5f8338b0ebe5d777f

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
