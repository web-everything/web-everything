---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/__tests__/shard-files.test.mjs", "we:scripts/lib/__tests__/soak-precheck-at-open.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a shard-files test with a partial timings map (some breaks timed, one untimed). Assert the un… (from web-everything/web-everything#7301 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/__tests__/shard-files.test.mjs:117` — Add a shard-files test with a partial timings map (some breaks timed, one untimed). Assert the untimed file is placed and the greedy split uses the median cost for it. This is a one-off test addition; no gate is warranted.
2. `we:scripts/conveyor/soak/__tests__/shard-files.test.mjs:116` — Add a deterministic test named 'assigns untimed breaks using the median measured duration' in this test file, using mixed measured durations and assertions that distinguish median weighting from constant weighting.
3. `we:scripts/lib/__tests__/soak-precheck-at-open.test.mjs:46` — Make the named no-read test intercept the actual filesystem boundary and assert that the timings file is never accessed; run it in the existing test gate.
4. `we:scripts/conveyor/soak/__tests__/shard-files.test.mjs:117` — Add a deterministic named test, 'weights untimed breaks with the median of measured timings', using mixed measured and untimed files and asserting the resulting weight or an assignment that distinguishes median weighting from zero and constant fallbacks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7301@fd052de669afe29fe1fec972af7477575d4778c8

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
