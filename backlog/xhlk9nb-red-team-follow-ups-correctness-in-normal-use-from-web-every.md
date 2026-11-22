---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7361 (head be0e08957)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7361 (reviewed head `be0e08957966399915a12af3074f6181229c61ae`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/hotpatch-readers.mjs:80` — (edge-case, degraded) Full-suite proof rejects valid logs showing zero quarantine exclusions
   - Scenario: With quarantine mode enabled and an empty quarantine list, decideCiSkip returns skip:[] and why:'no live quarantine entry'. CI therefore logs 'red-main-quarantine skip: no live quarantine entry' and runs every test. Given successful jobs and suite steps, fullSuite nevertheless returns false because the message lacks 'running everything'; admission consequently reports hotpatch-full-suite-unproven. It should accept verified zero-exclusion decisions, including this normal output.
   - Class: correctness-in-normal-use (basis: Executed the real decideCiSkip function with an empty list and supplied its exact output to the unchanged production fullSuite function body with successful job evidence. It returned false; the same evidence with the stop-mode 'running everything' message returned true.)
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
