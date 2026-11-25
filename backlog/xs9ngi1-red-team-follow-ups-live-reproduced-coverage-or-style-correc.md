---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style, correctness-in-normal-use] from web-everything/web-everything#7506 (head 434fa6c2b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7506 (reviewed head `434fa6c2b8584015abb2b45d1e80df3e1e1e62cc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:810` — (edge-case, degraded) A policy preamble allows a later failure to hide an earlier genuine error.
   - Scenario: Pass stderr containing '(node:1) DeprecationWarning: x\npolicy · drain.x=on\nTypeError: primary failure\nmerge-ai-prs ✗ Error: fast-drain: incomplete pass context (snapshot unavailable/disabled/stale/dirty) — retry next pass'. The selector returns the later fast-drain failure because it checks only the first non-warning line for an error shape. It should preserve the earlier TypeError diagnostic.
   - Class: live-reproduced (basis: Executed the unchanged selector extracted from the checkout with this stderr sequence and observed the later failure being selected.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/enqueue-on-event.mjs:765` — (failing-input, degraded) The allowlist rejects a failure message emitted by the context reader itself.
   - Scenario: Call readFastDrainContext with onlyPr=42, readSnapshot returning an empty array, readFull returning an object without baseRefName, and failClosed=true. It throws 'fast-drain: incomplete pass context (PR #42 base branch unreadable — cannot use incomplete full PR evidence) — retry next pass'. Format its stack using the script's handler prefix after the warning/policy preamble. firstStderrErrorLine returns '[unclassified stderr; see local log]' because '#' is excluded from SCRIPT_FAILURE_LINE. This native crash should surface its named reason.
   - Class: live-reproduced (basis: Executed the checkout's extracted context-reader functions to generate the actual error, then passed its formatted stack through the extracted selector and observed the unclassified result.)
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
