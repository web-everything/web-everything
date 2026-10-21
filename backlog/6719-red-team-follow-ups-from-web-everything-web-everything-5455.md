---
bornAs: xepdlr1
kind: story
size: 2
status: open
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5455 (head c0203a462)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5455 (reviewed head `c0203a4629cb35877b8088b34e65d1e744616fd9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/guard-bash.mjs:525` — (edge-case, degraded) The second heredoc's literal data is treated as executable commands.
   - Scenario: In orchestrator mode, submit 'cat &lt;&lt;A &lt;&lt;B first data A node we:scripts/operations/run.mjs verify B'. The hook denies it for delegation. Bash parses two heredocs attached to cat; the apparent verify command is literal data in the second heredoc and never executes. heredocScan consumes only the first body, leaving the second body's lines in raw text for prefix matching. Bash's declare -f confirmed both bodies remain redirections. The scanner should consume every pending heredoc and allow this data-only command.
   - Claude's re-check: The opener branch requires 'pending === null', so the second '&lt;&lt;B' on the same line is never registered. Only A's body is consumed. B's body line 'node we:scripts/operations/run.mjs verify' stays in the raw text and is prefix-matched, although bash treats it as literal heredoc data. This is a false deny.

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
