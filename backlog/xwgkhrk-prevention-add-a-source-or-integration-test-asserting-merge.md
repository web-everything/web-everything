---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/drain-mq-failure-recovery-io.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a source or integration test asserting merge-ai-prs invokes routeMqFailureOnHold whenever mqS… (from web-everything/web-everything#7343 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5244` — Add a source or integration test asserting merge-ai-prs invokes routeMqFailureOnHold whenever mqSameHeadGuard returns hold with recoveryAction 'fixer'.
2. `we:docs/agent/testing.md:6370` — File a follow-up card holding the three live receipts as an acceptance gate that must be recorded before the incident is closed.
3. `we:docs/agent/testing.md:6362` — Add a handoff gate that refuses to close a card while any acceptance row in the manifest reads BLOCKED or UNVERIFIED. Until it exists, file a follow-up card to record the three receipts.
4. `we:scripts/lib/__tests__/drain-mq-failure-recovery-io.test.mjs:1` — Add a caller-sweep test asserting that every same-head hold return path in we:scripts/merge-ai-prs.mjs reaches routeMqFailureOnHold. File a card for the wiring and its test.
5. `we:scripts/lib/__tests__/drain-queue-safety-same-head-retry.test.mjs:26` — Add a deterministic regression test that throws from PUT, recreates the refresh store, and asserts that no second PUT occurs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7343@5685d1466787ddeb48fcc037cf8e3b45b14ba595

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
