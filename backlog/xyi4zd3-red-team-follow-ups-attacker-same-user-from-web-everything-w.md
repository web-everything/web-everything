---
kind: story
size: 2
status: open
scope: ["we:scripts/guard-lane.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7583 (head 11f1c1bd9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7583 (reviewed head `11f1c1bd98cb6c8add4a6f5c4d5252cc96790bde`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/guard-lane.mjs:264` — (security, broken) The primary-edit escape hatch also disables Standards protection
   - Scenario: Invoke the CLI with WE_CONVEYOR_WORKER=1, LANE_GUARD_OFF=1, WE_HOOK_ROOT=/Users/nicolasgilbert/workspace/webeverything, and tool_input.file_path=we:/Users/nicolasgilbert/workspace/.operations/handoff/standards/drafts/core/authority/probe.md. It exits 0 with empty stderr; without LANE_GUARD_OFF it exits 2. The outer escape-hatch condition skips the new ownership check entirely. The prep explicitly requires no worker escape hatch, so this Standards write should remain denied.
   - Class: attacker-same-user (basis: Direct CLI probes reproduced the bypass for worker and unknown markers. Exploitation requires control of, or inheritance of, LANE_GUARD_OFF in the hook process environment; no cross-user access is demonstrated.)
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
