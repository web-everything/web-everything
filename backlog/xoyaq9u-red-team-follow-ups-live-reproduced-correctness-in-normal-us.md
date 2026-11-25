---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/urgent-verify.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7455 (head 97e5ab47d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7455 (reviewed head `97e5ab47de5e212d76f385d2ece84b442295597d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/urgent-verify.mjs:22` — (edge-case, degraded) Detached descendants survive the verification deadline
   - Scenario: Run a command that spawns a Node grandchild with detached:true and stdio:'inherit', prints its PID, and remains running. Using the unchanged supervisor with a 300 ms timeout, it returned ETIMEDOUT after approximately 1302 ms, but process.kill(grandchildPid, 0) still succeeded. The grandchild had a five-second lifetime and was explicitly terminated after observation. Killing only -child.pid misses descendants that create another process group. Repository tests already spawn such descendants, including we:scripts/__tests__/codex-direct-task.test.mjs. Expiry should terminate the owned verification d
   - Class: live-reproduced (basis: Executed the unchanged supervisor functions extracted into memory, without filesystem writes. Directly observed the detached grandchild remaining alive after the timeout returned.)
   - Also class: correctness-in-normal-use
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
