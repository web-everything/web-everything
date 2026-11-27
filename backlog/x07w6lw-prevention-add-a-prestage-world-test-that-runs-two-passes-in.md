---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:docs/agent/platform-decisions.md", "we:scripts/conveyor/soak/breaks/overlap-yield-skips-confirmed-mq-held-target.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/overlap-yield-skips-confirmed-mq-held-target.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a prestage-world test that runs two passes in one process (or calls main twice) and asserts t… (from web-everything/web-everything#7616 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:7368` — Add a prestage-world test that runs two passes in one process (or calls main twice) and asserts that the waiter yields again on pass 2 when the hold evidence is unchanged but not yet re-learned. More generally, add a review-lens rule: every scope or lifetime clause in a platform-decisions entry needs a test that crosses that boundary.
2. `we:docs/agent/platform-decisions.md:3833` — Add a single clause to the decision text, e.g. '(only while overlap-yield requires-landable is on, the default)'. A review lens should check that every policy-gated behaviour named in a platform-decisions entry also names its gate.
3. `we:scripts/merge-ai-prs.mjs:7368` — Add a deterministic two-pass regression test that observes restored overlap deferral in the second pass when no fresh confirmed refusal exists.
4. `we:scripts/conveyor/soak/breaks/overlap-yield-skips-confirmed-mq-held-target.mjs:1` — Add a two-pass regression test to the standard test gate, asserting restored overlap waiting once fresh admission no longer confirms the hold.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7616@4501b9fab86bc3bfc7dd599384f66ea726069dc2

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
