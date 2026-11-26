---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-audit-io.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7542 (head c407edce8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7542 (reviewed head `c407edce8bfc3ebe9cbc79294db6b45aaae7b19a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/codex-audit-io.mjs:104` — (failing-input, degraded) Inherited GIT_DIFF_OPTS bypasses the validated hunk-context setting
   - Scenario: Run the audit with GIT_DIFF_OPTS=--unified=0 and configured hunkContextLines=3. Git gives this environment variable precedence over the explicit --unified=3 argument, so the supplied material contains zero context while the audit logs three and records no policy error. Sanitize this variable so the supplied context matches the resolved policy.
   - Class: live-reproduced (basis: A read-only probe using the resolver and Git diff between existing files resolved three lines with no policy errors, but produced zero context lines under GIT_DIFF_OPTS=--unified=0; the baseline supplied 35 context lines. The new subprocess inherits this variable. The complete adapter was not executed because markdown-it is unavailable.)
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
