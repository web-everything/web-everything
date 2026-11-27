---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7613 (head 2b0d056c4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7613 (reviewed head `2b0d056c4ee5d0bb45b5a10a71dc57fab73b9a2b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/push-gate-lint.mjs:102` — (failing-input, degraded) Command pins reject valid asynchronous execFile callbacks
   - Scenario: With commands [\['rev-parse','--verify']\] and sites:1, execFile('git', ['rev-parse', '--verify', ref], callback) throws 'raw git command null is not pinned' because the callback is treated as options. The valid four-argument form with {shell:false}, callback also fails because arguments.length exceeds three. Both should admit the matching command while recognizing execFile's callback signatures.
   - Class: live-reproduced (basis: Executed both forms with ref='HEAD'; both completed successfully with exit code 0. Passing their source to findRawPushes with the matching pin reproduced rejection in both cases.)
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
