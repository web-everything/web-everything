---
bornAs: x9xkqew
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/accept-carry-forward.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Extract the fact derivation into an exported function that takes the PR listing and verdicts, and… (from web-everything/web-everything#4879 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5784` — Extract the fact derivation into an exported function that takes the PR listing and verdicts, and add a replay test over a stacked-PR listing. Backlog card xmp483n and the x7kz8uv standards check already point at the same inline-logic-in-`runCli` class.
2. `we:scripts/lib/accept-carry-forward.mjs:160` — Add a replay case for a post-accept CHANGES_REQUESTED followed by an APPROVED from the same reviewer, and compute the time-based objections only over reviews not superseded by that reviewer's later decisive state.
3. `we:scripts/lib/accept-carry-forward.mjs:119` — Match `**Advisory outcome:**` as an allowlist, so only `accept` is machine chatter and every other outcome blocks. Add a replay test that iterates the writer's outcome set (ADVISORY_OUTCOMES plus the pending-referral constant) and asserts which ones block.
4. `we:scripts/lib/accept-carry-forward.mjs` — Add a deterministic regression test matrix covering changes-requested followed by approval both before and after acceptance, and require it in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4879@3dc656501ee9912ed68481d023258c317170c0e7

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
