---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/audit-on-ready.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7325 (head a2b6126c4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7325 (reviewed head `a2b6126c48108886f18e739c97256d80ac679526`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/audit-on-ready.mjs:44` — (failing-input, degraded) Already-audited PRs appear owed when the daemon checkout lacks their head commit.
   - Scenario: Create and audit head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa in a lane clone, then supply PR 17 with that head and all three required labels while the daemon checkout lacks the commit. The canonical gate fails its initial local rev-parse before reading the shared audit ledger. The planner emits state owed, and the shadow hook logs and remembers this false debt. An isolated probe using the actual planner and canonical evaluator returned no debt when the commit resolved, but owed with the identical passing record when local resolution failed; the ledger was never read. Resolve evidence against
   - Class: correctness-in-normal-use (basis: Lane and daemon checkouts have separate object stores, so a newly published lane commit need not exist in the daemon checkout. The deterministic in-memory probe exercised the production planner and canonical evaluator with filesystem and git adapters stubbed; no live repository mutation or network access was used.)
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
