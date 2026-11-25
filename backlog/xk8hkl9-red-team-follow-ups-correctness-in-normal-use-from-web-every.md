---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7509 (head 5a19bf006)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7509 (reviewed head `5a19bf00685361e5b957acdf4dcfac3738d4b852`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1932` — (edge-case, degraded) A sequential retry can inherit the previous attempt’s terminal error
   - Scenario: Attempt A logs a terminal outcome with detail 'HTTP 429 Too Many Requests'. Attempt B starts later, appends startup text to the same log, then crashes without terminal JSON. B's write advances the file mtime past B's startedAt, so the reader returns A's error for B. The actual classifier consequently returns infra-transient instead of unknown, applying the wrong retry policy. Evidence should remain null unless terminal output can be attributed to B; use an attempt identifier, separate log, or recorded starting offset.
   - Class: correctness-in-normal-use (basis: No concurrent attempts or attacker are required. Executing the exact checked-in reader with in-memory filesystem inputs reproduced null before B's write and A's error afterward. Running the actual failure classifier confirmed the classification change. The full daemon import was unavailable because gray-matter is missing.)
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
