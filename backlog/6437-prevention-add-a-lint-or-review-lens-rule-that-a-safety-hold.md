---
bornAs: x43s3f0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/forge-land-provider.mjs", "we:scripts/review-set-label.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/forge-land-provider.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a lint or review-lens rule that a safety-hold write must not be gated on a preceding read. Re… (from web-everything/web-everything#5482 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/forge-land-provider.mjs:191` — Add a lint or review-lens rule that a safety-hold write must not be gated on a preceding read. Require a failure-injection test for any read added in front of a hold write.
2. `we:scripts/review-set-label.mjs:1417` — When a pure decision function gains a derived input, require one test through the real caller that exercises the derivation. A check:standards rule could flag new decide* parameters that the CLI test file never sets.
3. `we:scripts/review-set-label.mjs:365` — Make the parameter required with no default for the missing-only path, so a forgotten value throws. Add a CLI-level test for the trusted-marker case.
4. `we:docs/agent/testing.md:84` — Add a sweep test for a PR with no status label and a recorded result. Alternatively, narrow the doc sentence to stale-label removal.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5482@bf5ff0aa5dd96972760d4bef1170acf92f7eb20b

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
