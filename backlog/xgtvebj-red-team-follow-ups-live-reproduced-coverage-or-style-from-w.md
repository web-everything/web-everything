---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/agent-launch.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7170 (head 35e2fd31c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7170 (reviewed head `35e2fd31c2aff64c7680c87efe6beab4024cba72`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/agent-launch.mjs:182` — (edge-case, degraded) PATH identity checking normalizes away nonexistent directory components
   - Scenario: Supply a Codex descriptor with env.PATH='/Users/nicolasgilbert/.local/bin/definitely-absent-agent-dir/..'. firstCodex uses path.join, which removes the nonexistent component and finds the installed codex. The launcher admits and reaches spawn, although an actual PATH-based spawn of codex with this environment returns ENOENT. The identity check should inspect the literal PATH candidate and refuse because no executable Codex exists on that PATH.
   - Class: live-reproduced (basis: Observed launcher acceptance with the default production resolver and an intercepted spawn. Independently verified that access to the literal candidate and a real PATH-based spawn both fail with ENOENT.)
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
