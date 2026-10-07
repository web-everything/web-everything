---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pending-launches.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs", "we:scripts/conveyor/__tests__/pending-launches.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a lint or standards rule that every child_process.spawn result must have an 'error' handler.… (from web-everything/web-everything#4148 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pending-launches.mjs:35` — Add a lint or standards rule that every child_process.spawn result must have an 'error' handler. Add a test that spawns a nonexistent binary and asserts the launch settles as launch-died.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:338` — Add a test that makes settleLaunches throw and asserts no new dispatch and no orphan adoption occur that tick.
3. `we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs:34` — Require one named test per guard added in a diff. Keep a mutation spot-check in the lane checklist for new early-return guards.
4. `we:scripts/conveyor/pending-launches.mjs:62` — Store a process identity token (start time from `ps -o lstart= -p`, or a process-group id) in the record. Kill only when the token matches, and treat a mismatch as launch-died. A lint rule that flags `process.kill(` on a pid read from disk would catch the class.
5. `we:scripts/conveyor/pending-launches.mjs:75` — Recompute outFile and errFile from `root` and `id` at settle time instead of trusting stored paths. Require workDir to resolve under tmpdir() and to match the `build-dispatch-daemon-` prefix before the recursive rm. A lint rule that flags recursive `rmSync` on a value read from JSON would catch the class.
6. `we:scripts/conveyor/pending-launches.mjs:33` — Add a deterministic subprocess regression test that attempts a launch with an invalid working directory and verifies that the parent survives and the failed launch settles.
7. `we:scripts/conveyor/pending-launches.mjs:64` — Add a deterministic lifecycle test where kill returns but the PID remains alive, asserting that the pending record and claim remain held and another launch is refused until confirmed termination.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4148@5d8de1d564ab4c2075d5db13e4419ebd2ca00705

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
