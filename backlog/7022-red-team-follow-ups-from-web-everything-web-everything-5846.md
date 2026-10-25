---
bornAs: xzzbsd0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/lease-reaper.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5846 (head 62dbc0bc8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5846 (reviewed head `62dbc0bc8e48754f54f900c1771ce28c7e55337c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/lease-reaper.mjs:1478` — (edge-case, degraded) Session matching accepts a token embedded inside an unrelated process's argument.
   - Scenario: A fixer dies while its claim heartbeat remains fresh. Its PID is reused by an unrelated process launched as node -e 'setInterval(() =&gt; {}, 1000); /* --session=fix-5806 */'. The flattened command contains the whitespace-delimited session token inside the JavaScript argument. split(/\s+/).includes(...) therefore validates this unrelated process and preserves the abandoned lease until another reap axis fires. The identity check should reject it and allow session-gone reclamation. A probe using the checked-in helpers, a real live child PID, and injected command text reproduced keep with the claim
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
