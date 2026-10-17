---
kind: story
size: 5
parent: "xhwmyig"
status: open
blockedBy: ["xl3a0ik"]
scope: ["we:scripts/operations/incident-classify.mjs", "we:scripts/conveyor/nightly-coroner-job.mjs", "we:scripts/operations/incident-report.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Optional cheap LLM classification, nightly batch and metrics report

When no rule matches, send only the evidence bundle to a cheap model (Haiku 5.5 or Codex direct, synchronous) for a schema-checked result: cause, confidence, fix, scope and size. Confidence below 0.8 escalates; it never auto-queues. The LLM is off by default, with a token cap per day in the setting. The nightly coroner consumes the later queue. A daily report built from the ledger gives four metrics: time from episode open to card, auto-resolved share, false-positive incidents, and operator escalations per day. Acceptance: a schema rejection test; LLM off by default; token cap per day in the setting; the report is generated from the ledger with the four metrics; a mocked-model test never auto-queues low confidence. Operator decision 2026-10-17 (a): auto-queue a P0 fix only when a fixed rule matched the cause; LLM-proposed fixes wait for one-click operator approval.

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
