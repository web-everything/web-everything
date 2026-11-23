---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/delivery-tier.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7397 (head 7a3fe798c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7397 (reviewed head `7a3fe798cc635ff04156693a7c9d9cb1ecabcad0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/delivery-tier.mjs:59` — (edge-case, degraded) Unicode line separators bypass directory-wide HIGH rules
   - Scenario: classifyTier(['.claude/agents/\we:u2028.md'], {settings:{extraHigh:[]}}) returns LOW via **/*.md. The path passes validation, but trailing ** compiles to .*, which excludes U+2028 and U+2029. Every descendant of .claude/** should remain HIGH; use a matcher that includes these characters or reject them fail-closed.
   - Class: live-reproduced (basis: Direct Node probes reproduced LOW classifications beneath .claude, scripts/hooks, and .github/workflows. The classifier is currently observe-only.)
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
