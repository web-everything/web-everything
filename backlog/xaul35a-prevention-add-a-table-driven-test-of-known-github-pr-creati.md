---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a table-driven test of known GitHub PR-creation route aliases to we:guard-bash.test.mjs. This… (from web-everything/web-everything#7586 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:4607` — Add a table-driven test of known GitHub PR-creation route aliases to we:guard-bash.test.mjs. This is a deterministic gate, and no existing gate covers it.
2. `we:scripts/guard-bash.mjs:4590` — For each guard regex or split character class, require one test case per member of the class. A mutation-testing step over we:scripts/guard-bash.mjs would find this class of gap, but no such gate is known to exist.
3. `we:scripts/guard-bash.mjs:4588` — File a hardening card to normalise the path (collapse `//` and `.` segments, accept `repositories/<id>`) with matching test rows. This is outside-attacker hardening debt at the current release level.
4. `we:scripts/guard-bash.mjs:4545` — Extend the named regression test with unknown launchers combined with quoted and unquoted expanded option names, asserting no denial unless a visible gh operation establishes relevance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7586@b33a407cff23bd959a0704f61693bc04de00dda6

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
