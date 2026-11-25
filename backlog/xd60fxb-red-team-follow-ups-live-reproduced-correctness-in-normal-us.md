---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/agent-launch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7508 (head 24b7ff118)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7508 (reviewed head `24b7ff118772dd9f627748ab7972db110175c908`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/agent-launch.mjs:136` — (failing-input, degraded) Claude prompts starting with Markdown bullets are rejected before launch
   - Scenario: Call buildAgentArgs with agent='claude', githubRole='worker', cwd=process.cwd(), print=true, and prompt='- Review the diff\n- Report concrete failures'. It throws 'agent-launch: prompt must be a non-option, NUL-free string'. buildAgentInvocation performs the same validation before launching. This ordinary prompt should pass through unchanged: it is already placed after the '--' option delimiter, so its leading hyphen cannot introduce an option.
   - Class: live-reproduced (basis: Reproduced against the checked-out head using Node. Prefixing the identical prompt with 'Tasks:\n' succeeds, confirming that the leading Markdown bullet triggers rejection.)
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
