---
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7380 (head 45ff9ea37)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7380 (reviewed head `45ff9ea37a5cedd2894b43f7c29eddce3a5ee516`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1276` — (edge-case, degraded) One repository’s supersede read failure stops work across all repositories
   - Scenario: Run the default multi-repository tick with successful supersede reads for we, but a repo-specific HTTP 403 or timeout for frontierui. The new unconditional throw aborts the entire pass before fix, CI-heal, stuck-fixer reclamation, and mechanical CI recovery. Healthy repositories receive no work, and repeated failures keep them stalled. Dispatch should be held for the repository with unreadable evidence while healthy repositories and independent recovery work continue.
   - Class: correctness-in-normal-use (basis: The watcher converts ordinary read exceptions into error/blocked results. The new find-and-throw applies any such result to the entire pass, preceding all listed phases. This follows directly from the control flow; full daemon execution could not be verified because the snapshot lacks dependencies.)
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
