---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user, coverage-or-style] from web-everything/web-everything#7606 (head 75fa4f6cf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7606 (reviewed head `75fa4f6cfdc86e28175318fc121e6e7b3012d5e6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/main-ci-red-core.mjs:928` — (edge-case, degraded) Equal-timestamp recovery makes red duration depend on input order.
   - Scenario: Use a valid red event with repo='fixture/repo', head='abcdef0', seq=1, runId=1, at=60000, since=0, queue={waitMs:100,serviceMs:200}, signature=null and truncated=false. Add a green event with the same identity and timestamp, a distinct key and since=null. Query from=0, to=600000, now=600000. Red-first input reports 1 minute and zero open episodes; green-first reports 10 minutes and one open episode. Replay should recognize the recovery and return the same closed episode regardless of input order.
   - Class: live-reproduced (basis: A read-only Node probe executed the added metrics export block in memory. Both events passed validation, and reversing their order changed the result. No concurrency is required.)
   - Also class: attacker-same-user
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/main-ci-red-core.mjs:995` — (failing-input, degraded) Accepted extended-year timestamps collapse separate UTC days into one bucket.
   - Scenario: Create a valid red event with at=since=Date.parse('+010000-01-01T00:00:00Z'). Set from to that timestamp and to=now=from+172800000. The report returns days={'+010000-01':2880} without warnings. It should return two daily buckets of 1440 minutes each, or reject unsupported years explicitly. Slicing the ISO string to ten characters removes the day from extended-year dates.
   - Class: live-reproduced (basis: The read-only in-memory probe confirmed that validation accepts the event and the report merges both days. This is a synthetic boundary input within the explicitly accepted timestamp range.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
