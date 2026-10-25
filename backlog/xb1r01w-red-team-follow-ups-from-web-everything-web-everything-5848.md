---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5848 (head a9ed8e094)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5848 (reviewed head `a9ed8e0949af7cd3e1ee15895f683add5159da46`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:322` — (edge-case, degraded) Pending-swap cleanup silently treats Git errors as adoption still pending.
   - Scenario: With a valid pending swap and both overlays registered, make the initial 'git merge-base --is-ancestor &lt;newSha&gt; HEAD' return status 128, such as an unreadable commit object. Cleanup enters the pending-adoption branch and silently continues because the replacement remains registered. A read-only injected probe produced zero events and zero alerts. Repeated failures therefore retain the pending swap without the documented needs-you escalation. Distinguish ordinary non-ancestry (status 1) from command errors and report errors through reportNeedsYou.
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
