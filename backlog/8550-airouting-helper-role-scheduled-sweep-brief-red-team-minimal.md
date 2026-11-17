---
bornAs: x9x6kgw
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: []
---

# aiRouting helper role: scheduled-sweep, brief-red-team, minimal-context-provider, coroner-sample (design part 10 subset)

Route four helper call sites through aiRouting.helper; inherit parity, raise-only or provider-only.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/ai-routing-helper-sites.test.mjs` proves inherit parity, raise-allowed, lower-ignored, resolvable model, unusable refuses for the four sites.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] we:scripts/operations/review-precedents-io.mjs and we:scripts/operations/maintenance-io.mjs (wait for the account part); no account selection.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: routing values are settings, not prose.
2. **Truncated reads** — n/a: no reads.
3. **Shared state files** — n/a: no state files written.
4. **Fail closed** — Unusable model or provider refuses; a lowering override is ignored with a logged reason.
5. **Identity scoping** — n/a: account is never read.
6. **State over time** — n/a: stateless.
7. **Who wrote it** — n/a: settings come from the existing cascade.
