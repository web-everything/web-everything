---
bornAs: xd3ynbh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/session-watchdog.mjs", "we:scripts/conveyor/health-smells/ghost-session-listed.mjs", "we:scripts/conveyor/__tests__/session-watchdog.test.mjs", "we:scripts/conveyor/health-smells/__tests__/ghost-session-listed.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a test that a pid-less, unreadable-transcript, long-running live row is never classified as a… (from web-everything/web-everything#3895 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/session-watchdog.mjs` — Add a test that a pid-less, unreadable-transcript, long-running live row is never classified as a clearable ghost. A deterministic option is a lint or test asserting every destructive watchdog action requires a positive, pid-based death signal.
2. `we:scripts/conveyor/session-watchdog.mjs` — Add a deterministic regression test with more than 2,000 entries that requires old emitted and acknowledged keys to remain effective, backed by durable key storage or semantics-preserving compaction.
3. `we:scripts/conveyor/health-smells/ghost-session-listed.mjs:25` — Add a deterministic duplicate-name regression test with different handles and mixed removal outcomes; match actions by handle and aggregate any shared episode so an uncleared ghost remains visible.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3895@1755ff9dbf9120fce1b7f97b67428bc7e36c3a93

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
