---
bornAs: xotfq9h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Build summarizer fixtures from a captured real merge-ai-prs --json result, or share the result-sh… (from web-everything/web-everything#5197 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:139` — Build summarizer fixtures from a captured real `merge-ai-prs --json` result, or share the result-shape constants with the producer. A contract test would catch this class of defect.
2. `we:scripts/lib/enqueue-on-event.mjs:158` — Add a deterministic fake-timer lifecycle test with a child that ignores SIGTERM, asserting bounded termination escalation and eventual settlement of tick() and idle(); run it in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5197@b231f2c38461ce700695fcadf3a469e5ed5ecc06

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
