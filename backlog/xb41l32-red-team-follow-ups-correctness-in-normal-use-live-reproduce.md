---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, live-reproduced, attacker-same-user] from web-everything/web-everything#7456 (head c2058ff50)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7456 (reviewed head `c2058ff507f21d7d935344a0eef4b0dbf8583172`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:3936` — (failing-input, degraded) Takeover diagnostics omit the documented holder-slug release identity
   - Scenario: Acquire with --session=worker, retain the printed holder slug, let the lease expire and be reclaimed, then run release --lane=1 --session=&lt;holder-slug&gt; after the taker releases. The diagnostic matches only leaseSession/session and prints plain 'no lease to release', despite acquire history linking that holder to worker. It should resolve the holder identity and explain the recorded takeover.
   - Class: correctness-in-normal-use (basis: Acquire explicitly prints release using the minted holder slug. A read-only execution of the production formatter with acquire and expiry records reproduced the missing explanation; using worker against identical records produced the explanation.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:3934` — (edge-case, degraded) A null history entry crashes the new missing-lease diagnostic
   - Scenario: With no lease marker, a JSONL entry containing null in either lane-1/.git/lane-history.jsonl or the pool's .lane-journal.jsonl causes release --lane=1 to throw TypeError. Both history readers retain JSON null, while the new filters unconditionally access e.action or e.lane. Invalid history entries should be skipped so release can print its plain missing-lease message.
   - Class: live-reproduced (basis: Executed the actual production formatter in an isolated VM with JSON.parse('null') in each reader result. Both cases threw TypeError. This requires a malformed historical entry; no filesystem mutation or full CLI invocation was used.)
   - Also class: attacker-same-user
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
