---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/agent-launch-structure.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7577 (head 471c6b13e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7577 (reviewed head `471c6b13efd70a403e0584b9e78309c922785104`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/agent-launch-structure.test.mjs:30` — (edge-case, degraded) Parentheses let same-file aliases evade the new tripwire.
   - Scenario: literalLaunches("const s = (cp.spawn); s('codex');") returns [], while removing the initializer parentheses returns ['codex']. Likewise, "import { spawn as run } from 'node:child_process'; (run)('codex', []);" returns []. These parentheses preserve JavaScript behavior; both inputs should count one launch. Unwrap ParenthesizedExpression nodes before checking initializers and callees.
   - Class: live-reproduced (basis: Executed the checked-out literalLaunches function with TypeScript and observed both false negatives alongside positive unparenthesized controls. These are literal, same-file aliases, without dynamic commands or cross-file resolution.)
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
