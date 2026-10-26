---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/completion-cli.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5943 (head db09e13bc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5943 (reviewed head `db09e13bcf8e69366df20203ad1d509fa7b6bbea`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/completion-cli.mjs:165` — (failing-input, degraded) Sibling-repository blocks are incorrectly attributed to Web Everything.
   - Scenario: Run report --kind=fix --pr=42 --repo=frontier-ui/frontierui --status=done --outcome=blocked-on-permission --denied='git push' --session-id=owner-A. The completion correctly identifies session fix-fui-42, but the new event omits repo, so appendDaemonEvent defaults it to 'web-everything'. A read-only probe executing the report and writer with in-memory storage reproduced this: the FrontierUI event is indistinguishable from a Web Everything PR #42 event apart from its timestamp. The event should retain FrontierUI's repository identity, deriving it from the persisted session when necessary.
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
