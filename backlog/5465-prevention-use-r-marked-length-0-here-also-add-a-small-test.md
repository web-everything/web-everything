---
bornAs: xmziuml
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/lib.test.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Use r.marked?.length ?? 0 here. Also add a small test that drives the poll-result handling with an {ok:fa… (from plateauapp/plateau-app#218 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:240` — Use `r.marked?.length ?? 0` here. Also add a small test that drives the poll-result handling with an `{ok:false}` result. Longer term, extract the feedLoop body into a pure, injectable function in we:lib.mjs so it is testable.
2. `we:tools/drain-daemon/lib.test.mjs:1982` — Extract the pass-start snapshot/ack decision into a pure lib function (for example `decideFeedAck({exit, snap})`) and test it. Or add source-regex guards like the existing ones: ack gated on `entry.exit === 0`, and `take()` before `runPass`.
3. `we:tools/drain-daemon/daemon.mjs:608` — Add a deterministic fake-consumer lifecycle test to the required test suite that inserts a mark during a pass and asserts acknowledgement preserves it for the next pass.
4. `we:tools/drain-daemon/daemon.mjs:663` — Add a deterministic fake-clock loop test that starts a healthy 300-second sleep, changes feed health to unreachable, and asserts the next pass starts by the base-interval deadline.
5. `we:tools/drain-daemon/daemon.mjs:608` — Add deterministic lifecycle tests asserting retained dirty marks after failure, survival of later marks after acknowledgement, and restored cursor plus pending marks after consumer recreation; run them in CI.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#218@3370987cf95107fe5e26728f333b2700ff33ae96

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
