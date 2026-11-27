---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/lib/verify-lane-gate.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Review lens or test-plan rule: every new refuse branch needs a paired accept-case test. A mutatio… (from web-everything/web-everything#7563 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:57` — Review lens or test-plan rule: every new refuse branch needs a paired accept-case test. A mutation-testing gate on changed lines would catch it deterministically.
2. `we:scripts/lib/verify-lane-gate.mjs:598` — File a card to pin the validator's content, for example by comparing it to the merge-base blob via git show or checking a known export marker. Give it a deterministic gate test.
3. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:78` — Review lens: every negative-existence assertion needs a paired positive control, or the test should observe an actual spawn through an injected runner.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7563@8164bfddcf00fb5ad1ed7d897343aa67a9889597

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
