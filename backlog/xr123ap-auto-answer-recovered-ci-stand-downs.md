---
kind: story
size: 3
status: open
dateOpened: "2026-10-26"
tags: [conveyor, ci, stand-down]
scope: ["we:scripts/conveyor/stand-down-auto-proceed.mjs", "we:scripts/conveyor/stand-down-auto-proceed-io.mjs", "we:scripts/conveyor/stand-down-auto-proceed.md", "we:scripts/conveyor/stand-down-answer.md", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/stand-down-auto-proceed.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
---

# Record R123 automatic answers when a CI stand-down no longer represents a real failure

Operator ruling R123 authorizes automatic proceed answers for same-head successful reruns, cancelled or
skipped checks, and exhausted repair loops caused only by main's red CI. Judgment stand-downs and genuine
required failures continue to hold.

The pure classifier is we:scripts/conveyor/stand-down-auto-proceed.mjs. Its injected reconciliation writer
is we:scripts/conveyor/stand-down-auto-proceed-io.mjs; the contract and operator fallback are documented
in we:scripts/conveyor/stand-down-auto-proceed.md. Answers use the existing strict builder/parser with
actor `auto-R123` and channel `auto (R123)`. A durable reservation prevents duplicate posts, including
after ambiguous writes. Existing main-red classifiers are reused; no review gate or setting is bypassed.

Focused evidence lives in we:scripts/conveyor/__tests__/stand-down-auto-proceed.test.mjs and the
reconciliation wiring test in we:scripts/conveyor/__tests__/reconcile-pass.test.mjs. Deployment and live
GitHub observation are left to the human review and deployment flow.

## Acceptance

- Cases (a), (b), and (c) produce a strict, trusted answer that supersedes the CI stand-down exactly once.
- The three-candidate tick bound rotates durably across ticks so persistent earlier holds cannot starve
  a later recovered PR; cursor failures retain all holds with an operator-answer fallback.
- Judgment holds, genuine failures, missing or invalid stand-down identity/time, and unbound heads hold
  without reserving or posting an answer.
- Threads of 2000 comments and answer bodies of 60000 characters are accepted when otherwise eligible;
  2001 comments or 60001 characters hold without posting and identify the operator fallback.

## Risks

Newest-wins answers could otherwise clear an older judgment question; the classifier refuses that case.
Incomplete CI evidence retains the hold. A crash or ambiguous write after durable reservation requires
operator inspection before a manual retry. Size limits must remain inclusive at their documented boundary.

## Test plan

Run we:scripts/conveyor/__tests__/stand-down-auto-proceed.test.mjs through the host heavy-run queue.
Named identity/time and unbound-head tests assert both the pure hold and zero writer reservations/posts.
The named 2000-comment and 60000-character boundary pairs prove acceptance at each exact limit and refusal
immediately above it, so deleting or shifting either guard fails a focused assertion. Answer-body fixtures
use the public builder to establish their exact size independently of the classifier's size guard.
Existing cases cover strict parsing, main-red attribution, judgment preservation, incomplete reads and
durable write deduplication. The existing wiring test in
we:scripts/conveyor/__tests__/reconcile-pass.test.mjs covers enrichment before terminal refusal planning.
Run `npm run check:standards` through the same queue for the card and contract notes.
