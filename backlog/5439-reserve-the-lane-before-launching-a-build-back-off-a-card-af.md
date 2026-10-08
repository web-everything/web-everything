---
bornAs: x87v3ed
kind: story
size: 3
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Reserve the lane before launching a build; back off a card after a failed start

3 of 7 Claude builds never started (lane already leased by another role). The dispatch sink now takes the lane lease before spawning and hands it to the worker by session slug; a never-started build records a build failure so the card backs off.

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

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/dispatch-lane-io.test.mjs we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs` fails on old code and passes after: the build sink reserves lane N under the worker's session slug before it spawns, refuses (no process) when the lane is already leased, and an orphan-released build records a build failure so the card backs off.
