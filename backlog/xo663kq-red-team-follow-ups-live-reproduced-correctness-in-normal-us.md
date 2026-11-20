---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/author-stamp-restore.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7231 (head 4eb4d9ba5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7231 (reviewed head `4eb4d9ba59168fa55e8f1c2e8574155d88386968`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/author-stamp-restore.mjs:62` — (failing-input, degraded) An apostrophe in ordinary link text prevents valid restoration.
   - Scenario: Use one oldest snapshot edited by User alice, authorLogin alice, state OPEN, live body 'Current description', and snapshot diff '[Author’s guide] (https://example.test/guide)\n\n&lt;!-- authored-by-actor: 01f39b97-274a-4078-8eeb-e7f8d6008673 --&gt;', replacing the curly apostrophe with the ASCII character U+0027. The quote counter includes the apostrophe in the link label, declares the link ambiguous, and refuses restoration without writing. This is a completed link followed by a genuine standalone stamp and should restore.
   - Class: live-reproduced (basis: Executed the restoration write path with the ASCII-apostrophe input and observed refusal with zero writes. A control using '[Guide] (https://example.test/guide)' restored successfully through the same injected I/O seams.)
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
