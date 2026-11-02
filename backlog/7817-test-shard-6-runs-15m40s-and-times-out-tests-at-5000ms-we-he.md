---
bornAs: xisvj20
kind: story
size: 2
status: open
scope: ["we:health-watch-core.test.mjs", "we:daemon-rebuild-skip-unrelated.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# test-shard (6) runs ~15m40s and times out tests at 5000ms (we:health-watch-core.test.mjs on main 9426fda44

MED priority hint. - (2026-10-28 14:00 ET) test-shard (6) runs ~15m40s and times out tests at 5000ms (we:health-watch-core.test.mjs on main 9426fda44; we:daemon-rebuild-skip-unrelated.test.mjs on #6036). Rebalance shard 6 (timings refresh) and find the slow file(s); quarantined we:health-watch-core.test.mjs 24h meanwhile.

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
