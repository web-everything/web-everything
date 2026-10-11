---
bornAs: xwtz2an
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4797 (head 26eff6d2a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4797 (reviewed head `26eff6d2ae558abf97e7219d883eaea22d354d0f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:1479` — (edge-case, degraded) A takeover marker sharing the ruling's timestamp does not spend the grant.
   - Scenario: At attempts=6, cap=5, allowance=1, post a covering operator block ruling followed by an unvoided takeover marker for the same head, both with createdAt=2026-10-03T09:20:00Z. After that session ends without changing the head, reconcile again with no live agents. A production planner probe returned used=0 and dispatched another directed takeover because the timestamp comparison is strictly greater-than. Moving the marker timestamp later correctly returned ruling-round-spent and no dispatch. The later comment must spend the grant even when timestamps tie; use thread order or comment identity to d
   - Claude's re-check: operatorRulingRound counts only markers with Date.parse(m.at) &gt; rulingAtMs. A marker with the same createdAt as the ruling is never counted, so used stays 0 and a second directed takeover can dispatch.

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
