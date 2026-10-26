---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5922 (head 5e8db5677)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5922 (reviewed head `5e8db56777b1a770ea35c1f94bfef6628cd3ed05`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/red-team-gate.mjs:703` — (failing-input, degraded) Rejected automation-authored operator-card lines still suppress legitimate card filing.
   - Scenario: For a live result R containing confirmed break #1, append a trusted automation comment with outcome=card-queued, result=R, and the action line '- 1 finding(s) carded by the operator to 'we:backlog/nonexistent.md' (#1).', followed by a round-cap record holding #1. The release reader correctly rejects the operator-only action, but operatorRulingsOnLiveResult marks #1 carded because card-queued is an automation release outcome. A Node probe confirmed held=[1], ruled=[], carded=[1] with anyState both false and true. Consequently, rulableBreaks filters out #1 when ruling card without --card, preven
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
