---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/completion-cli.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5943 (head 1925ac5b8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5943 (reviewed head `1925ac5b860466cb6d728d4399ee429f0ba22ad9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/completion-cli.mjs:165` — (failing-input, degraded) Sibling-repository permission blocks are attributed to Web Everything
   - Scenario: Report started and then blocked-on-permission for kind=fix, pr=42, repo=frontier-ui/frontierui and the same session-id. A read-only probe executing the actual reporting and event serialization code with memory-backed IO produced session fix-fui-42 but an event containing repo='web-everything', pr='42'. The emitter receives no repository, so the shared writer supplies its WE default. The event should identify Frontier UI PR #42.
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
