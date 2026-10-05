---
bornAs: xjnacg4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:skills-src/conveyor/__tests__/verify-daemon.test.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Build the vitest flags in one shared helper that both the gate composer and the retry command use… (from web-everything/web-everything#3994 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:201` — Build the vitest flags in one shared helper that both the gate composer and the retry command use. Alternatively, add a test that asserts every vitest invocation built in we:verify-lane.mjs carries the same scaled flags.
2. `we:skills-src/conveyor/verify-daemon.mjs:78` — Export `defaultIsDraining` or take its env and path as parameters, then add a test that uses a temp marker file. A lint or standards rule could also flag `process.env.VITEST` branches in production modules.
3. `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs:537` — Add a deterministic test that dispatches a deferred gate, enables draining, verifies the gate remains counted, then resolves it and asserts marker settlement before the count reaches zero.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3994@e7f73591523232e56136574cd58cc37510958d29

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
