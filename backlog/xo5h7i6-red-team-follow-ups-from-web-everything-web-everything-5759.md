---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/health-watch-lane-scan.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5759 (head f7c0342cc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5759 (reviewed head `f7c0342cc13b54535afd6c8ef7a62939b5c87aaa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/health-watch-lane-scan.mjs:74` — (failing-input, degraded) A valid fetch refspec is misclassified as dangerous Git configuration
   - Scenario: Configure remote.origin.fetch as +refs/heads/main:refs/remotes/origin/backup.promisor in an otherwise clean, published lane. configKeyCandidates includes the entire key\nvalue entry, and the dot-all remote.*.promisor regex matches that entry because its value ends in .promisor. freshLaneSafety consequently refuses the lane as redirecting objects, transport or worktree; stale-state also skips its ahead calculation. A read-only probe using this config-list entry and real Git for every other check changed guardLaneAction.act from true to false. The parser should recognize remote.origin.fetch as t
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
