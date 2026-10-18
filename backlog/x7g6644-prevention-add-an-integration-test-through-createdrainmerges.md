---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/lib/__tests__/drain-saved-red-team.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add an integration test through createDrainMergeStrategy.enqueue that uses an unparseable or no-v… (from web-everything/web-everything#5551 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/drain-red-team-evidence.mjs:70` — Add an integration test through createDrainMergeStrategy.enqueue that uses an unparseable or no-verdict row, advances the clock past redTeamPendingMaxMin, and asserts the intended outcome (enqueue with the never-scheduled note). Pin the decision so a later change cannot flip it silently.
2. `we:scripts/lib/drain-saved-red-team.mjs:25` — Add a deterministic integration test with usable posted evidence and corrupt saved storage, asserting admission succeeds without consulting saved storage; run it in the existing test gate.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #4706.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5551@76ad28617c559e24f83aa781d66b43f9ca5a9935

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
