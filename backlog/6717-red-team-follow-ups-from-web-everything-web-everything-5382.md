---
bornAs: xe5zo6k
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5382 (head 2142589ba)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5382 (reviewed head `2142589bab64b60b25eccb32544c2e335ae21015`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2271` — (failing-input, degraded) Replay drops repository prefixes and reports the wrong model
   - Scenario: Replay a round-3 FrontierUI PR whose files contain we:docs/agent/example.md, using default settings and ladder. Replay passes the unprefixed path to criticalWorkVerdict, treats it as WE statute work, and reports --model opus. The actual planner supplies frontierui:docs/agent/example.md, which is non-critical, and launchTableFor selects Sonnet. Reproduced both model results from the checked-out function source. Replay should preserve the planner's repository-prefixed scope so its model prediction matches dispatch.
   - Claude's re-check: Dispatch scopes carry repo prefixes (the tests use 'we:scripts/...'). replayFixLaunch builds scope from raw view.files paths with no prefix, so criticalWorkVerdict sees different input than dispatch does and replay's predicted model can diverge. The specific FrontierUI and docs/agent example depends on code not shown, but the prefix mismatch is real.

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
