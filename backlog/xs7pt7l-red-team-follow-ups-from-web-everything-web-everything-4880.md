---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4880 (head ab5ce88f3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4880 (reviewed head `ab5ce88f3e3b559e042117db17cd30d0bc25d303`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:483` — (edge-case, degraded) A completed begin marker can refund later heals when a subsequent begin comment is lost.
   - Scenario: Trusted comments: fix-4631 begins at aaaaaaaaa, ends at bbbbbbbbb, then three heal attempts occur. A later fix-4631 turn's begin comment fails to post (explicitly tolerated by fixBegin), and that turn ends without pushing, again at bbbbbbbbb. beginSha still contains aaaaaaaaa from the completed first turn. A read-only probe returned the later end as resetAt and reduced the charged attempts from 3 to 0. The completed begin should be consumed; an unmatched later end must not refund attempts without evidence of another push.
   - Claude's re-check: 'beginSha' is never cleared after a fix-end, so an unmatched later end reuses the stale begin sha (aaaaaaaaa). That differs from bbbbbbbbb, so it becomes the newest 'latest'/resetAt and refunds the heals posted between the two ends.
2. `we:scripts/conveyor/reconcile-core.mjs:484` — (edge-case, degraded) Distinct heads sharing seven hexadecimal characters fail to reset the budget.
   - Scenario: Supply three prior heals followed by trusted fix-4631 begin/end markers whose recorded SHAs are 1234567aa and 1234567bb. The canonical builders preserve all nine characters, so the markers establish different heads. The comparison truncates both to seven characters: a read-only probe returned reset=null and retained all three charged attempts. The planner consequently remains exhausted despite a new fixer head. Compare the available SHA prefixes without discarding distinguishing characters.
   - Claude's re-check: The regex accepts 7–40 hex characters, but the comparison does 'from.slice(0,7) === sha.slice(0,7)'. 1234567aa and 1234567bb therefore compare equal and no reset is recorded. The collision is very unlikely in practice, but the code does misbehave on that input.

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
