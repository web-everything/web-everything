---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/minimal-context-provider.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7332 (head d2b149d3f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7332 (reviewed head `d2b149d3f5d3a3e3563aacb72e17882e462c62e8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/minimal-context-provider.mjs:218` — (failing-input, degraded) Copied relative hooks fail in the repair session’s scratch directory.
   - Scenario: Launch a fresh fix or ci-heal session with the current repo settings. Its initial UserPromptSubmit hook runs 'node we:scripts/broadcast-inject.mjs' from the per-session scratch directory, where that script does not exist. Running this exact command from the existing dispatch scratch root reproduced MODULE_NOT_FOUND and exit 1. Operator broadcasts cannot reach the session through this hook before it changes directory. Hook paths should resolve against the repo independently of the session cwd.
   - Class: correctness-in-normal-use (basis: The copied command failed in the existing dispatch scratch root. Both launch paths explicitly use a per-session child of that root; no complete agent session was launched.)
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/minimal-context-provider.mjs:183` — (security, broken) The required-guard validator accepts a guard name appearing only in a shell comment.
   - Scenario: Keep the canonical settings but replace the Bash guard command with 'true # we:scripts/guard-bash.mjs'. Passing this JSON through LEAN_FIX_HOOKS_SETTINGS('/dev/stdin') succeeded and returned the replacement verbatim. Executing that command returned zero without invoking any guard. Consequently the claimed fail-closed check accepts an absent Bash guard. It should reject this configuration rather than treating a script-name substring as proof of guard execution.
   - Class: attacker-same-user (basis: Reproduced entirely in memory and through a pipe. Exploitation requires modifying the trusted launch checkout’s settings; no remote write path to that configuration was established.)
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
