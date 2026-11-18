---
bornAs: xfxsxbm
kind: story
size: 3
status: active
scaffoldedBy: "ci-heal-airouting"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/probation-heal-run.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# aiRouting ci-heal role: ci-heal reads aiRouting as optional resolver input (part 5)

Design part 5 of the aiRouting setting (handoff doc, ai-routing design). we:scripts/operations/ci-heal-pr-dispatch.mjs and we:scripts/operations/probation-heal-run.mjs read aiRoutingInputs('ci-heal') as an optional resolver input; 'inherit' keeps today's route exactly (parity test). A configured route passes through resolveOperationRoute, the code-writing chain still ends with Claude, and the stronger-model route still refuses non-Claude.

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
