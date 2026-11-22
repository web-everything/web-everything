---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/lib/agy-review-juror.mjs", "we:scripts/lib/agy-sandbox.mjs", "we:scripts/lib/critical-work.mjs", "we:scripts/lib/dispatch-contracts.mjs", "we:scripts/lib/dispatch-routing-policy-io.mjs", "we:scripts/lib/dispatch-routing-policy.json", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/lib/model-probation-registry.mjs", "we:scripts/lib/model-probation.json", "we:scripts/lib/model-probation.mjs", "we:scripts/lib/provider-quota-hold.mjs", "we:scripts/lib/provider-routing.mjs", "we:scripts/lib/review-model-eligibility.mjs", "we:scripts/lib/review-seat-provider.mjs", "we:scripts/lib/settings-registry-metadata.json", "we:scripts/operations/ai-routing.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-seat-runner.mjs", "we:scripts/operations/run.mjs", "we:scripts/settings/agy-build.json"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/prov-ab-flash-settings into focused changes

size-split-key:879120cd4f96e8e449cdfcba9b8ce7a881a4b0e9cadd3b1c499f6d5a36ee4819. Plan follow-up splits for PR lane/prov-ab-flash-settings. File groups: we:docs/agent: 28; we:scripts/lib: 448; we:scripts/operations: 50; we:scripts/settings: 2

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
