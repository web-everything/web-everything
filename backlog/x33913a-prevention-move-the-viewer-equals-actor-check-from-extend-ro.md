---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/operator-controls-io.mjs", "we:scripts/operations/operator-why.mjs", "we:scripts/operations/__tests__/operator-controls-io.test.mjs", "we:scripts/operations/__tests__/operator-why.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Move the viewer-equals-actor check from extend-rounds-io into validateOperatorAttribution or the… (from web-everything/web-everything#5169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/operator-controls-io.mjs:96` — Move the viewer-equals-actor check from extend-rounds-io into `validateOperatorAttribution` or the shared sink, and add a test that every CONTROL_OPS entry refuses a mismatched viewer. A check:standards rule requiring each registered operator op to call the shared credential binding would make this deterministic.
2. `we:scripts/operations/operator-why.mjs:72` — Share one `assertRepoSlug` helper and have the operation registry reject any input named `repo` that does not match it. That lint-level gate covers every op's `repo` input.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5169@d8604e6334e79099e888ab869622124e62ad2706

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
