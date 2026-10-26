---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gate-config.mjs", "we:scripts/lib/delivery-policy.mjs", "we:scripts/lib/__tests__/gate-config.test.mjs", "we:scripts/lib/__tests__/delivery-policy.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a review-lens checklist item: every 'null means X' or 'cannot Z' sentence in a doc comment mu… (from web-everything/web-everything#5936 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gate-config.mjs:836` — Add a review-lens checklist item: every 'null means X' or 'cannot Z' sentence in a doc comment must name its test. A deterministic gate is not feasible for prose.
2. `we:scripts/lib/delivery-policy.mjs:83` — Add a review-lens rule: a cache beside a trust check needs a test that flips the trust input while the cache key stays the same.
3. `we:scripts/lib/delivery-policy.mjs:112` — Either make the loader refuse or warn (falling back to the failsafe) when `GITHUB_ACTIONS` is set and `ref` is undefined, or add a check:standards rule that CI workflows invoking we:scripts/lib/delivery-policy.mjs must pass `--ref`. Add a test for the Actions-without-ref case.
4. `we:scripts/lib/gate-config.mjs:817` — Add deterministic subprocess-limit cases to we:scripts/lib/__tests__/gate-config.test.mjs and require them in the existing test gate.
5. `we:scripts/lib/delivery-policy.mjs:88` — Add a deterministic warm-cache trust-revocation test, including changed confinement, to we:scripts/lib/__tests__/delivery-policy.test.mjs.
6. `we:scripts/lib/gate-config.mjs:826` — Add a deterministic subprocess-interaction test in we:scripts/lib/__tests__/gate-config.test.mjs that asserts one ref resolution and identical commit IDs for both source reads.
7. `we:scripts/lib/delivery-policy.mjs` — Add a deterministic regression test with unavailable base-registry evidence and no pointers, asserting an explicit registry warning while valid inline settings remain available.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5936@10b90c4a65ce203bee82d36c3427ac7f74da4112

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
