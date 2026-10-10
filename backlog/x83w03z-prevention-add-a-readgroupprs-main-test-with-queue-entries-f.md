---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-ci.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a readGroupPrs/main() test with queue entries from a preceding group and a base..head range c… (from web-everything/web-everything#4708 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-ci.mjs:196` — Add a readGroupPrs/main() test with queue entries from a preceding group and a base..head range covering only the current group. Assert either those PRs are excluded (they are evaluated in their own group's run) or they get a pin.
2. `we:scripts/lib/merge-gate-ci.mjs:222` — Give the workflow-edit rule its own non-skippable inventory gate id, or exempt it in `finish()`. Add a test that no gate whose rule has no drain counterpart can be placed on 'drain'.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4708@34590bfe2a8b8bcacd14370365e534a02a0cc477

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
