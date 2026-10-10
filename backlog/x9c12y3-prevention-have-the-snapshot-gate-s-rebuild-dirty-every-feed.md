---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/wip-publish.ts", "we:src/wip/shared-source.ts", "we:src/wip/__tests__/wip-event-driven.test.ts", "we:scripts/__tests__/wip-publish.test.mjs", "we:src/wip/__tests__/shared-source.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Have the snapshot gate's rebuild dirty every feed gate that declares a snapshot dependency (a dependsOnSn… (from plateauapp/plateau-app#223 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/wip-publish.ts:186` — Have the snapshot gate's rebuild dirty every feed gate that declares a snapshot dependency (a `dependsOnSnapshot` flag on the signal). Add a wiring test that asserts a snapshot rebuild re-dirties those feeds. A lint requiring each feed that reads `lastSnapshot` to declare the dependency would also catch the class.
2. `we:src/wip/shared-source.ts:172` — Emit a signal on any change of the `state` value. The lifecycle watcher already tracks the previous state, and the 4 KB head read is cheap. Add a test for working → blocked and for a done session resumed.
3. `we:src/wip/shared-source.ts:110` — Give each setting its own minimum, with a floor of 1000 ms for interval-type keys. Add a settings test that 0 is rejected for those keys.
4. `we:src/wip/shared-source.ts` — Add a deterministic fake-clock test that calls read repeatedly after a signal and asserts the underlying reader's call count remains unchanged until the configured floor expires.
5. `we:src/wip/shared-source.ts` — Extend the deterministic incremental-session test with a clock advance exceeding the window and an expired row in the delta; assert that the final verdict excludes that row.
6. `we:src/wip/__tests__/wip-event-driven.test.ts` — Add a deterministic filesystem-spy test asserting the read offset and maximum requested byte length, and rejecting full-file reads on this path.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#223@37c77c783e3e34a435b990d5297e54e5bf39b864

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
