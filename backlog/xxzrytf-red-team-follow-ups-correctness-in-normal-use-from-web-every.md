---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7238 (head 5ba80463c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7238 (reviewed head `5ba80463c199c32ebde6c60cfed1867aec7b7713`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-heal-loop.mjs:74` — (edge-case, degraded) CI-heal-only ticks erase saved fix continuation cursors.
   - Scenario: Start with a valid we:.conveyor/fix-pass-cursors.json containing prCursors.fix["web-everything/web-everything"]=7238 after a budget-limited fix pass, then run the child with --once and authentication available. runTickAllRepos loads the same cursor store as the parent. Its boundedPrTick wrapper processes the injected empty fixTick result, deletes that repo's cursor because nextCursor is absent, and persists the changed state. Restarting the parent loses its continuation point and can repeatedly revisit earlier PRs instead of reaching deferred work. A CI-heal-only tick should preserve cursors for
   - Class: correctness-in-normal-use (basis: The default child calls the real runTickAllRepos without isolating cursor state or persistence. That function loads shared defaults, deletes cursors for results without nextCursor, and saves changed defaults. This requires ordinary persisted state and sequential execution, not concurrent writers. Runtime reproduction was blocked by missing dependencies; the finding follows the source control flow.)
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
