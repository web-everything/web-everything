---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-drain.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Legacy lane-drain with a crash between the couple merge and finalizeLand leaves the item queued and its manif…

Flow-sim gap R8a-G5, class K3 (one-shot step, no re-driver). Failing input: we:queued.json lists #4459 with lane lane/4459-foo; couple impl+WE merged by pr-land (lane ref deleted by --delete-branch). lane-drain process dies before finalizeLand/unqueue (line 1317). Cited: we:scripts/lane-drain.mjs:1317-1330, we:scripts/lane-drain.mjs:1539-1540, we:scripts/lane-drain.mjs:517, we:scripts/lane-drain.mjs:526-534, we:scripts/lane-drain.mjs:287. Soak-break sketch: Fixture: we:queued.json with #4459, a gh stub returning no open PR for the head and a missing ref, but a MERGED PR for the head. Action: planWatch/onePass. Assert (fails today): the entry is classified 'already-landed' and finalizeLand is invoked; today it is…

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
