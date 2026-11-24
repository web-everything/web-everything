---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/sibling-base-check.mjs", "we:scripts/operations/open-pr-io.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7431 (head 0fb4c8f0b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7431 (reviewed head `0fb4c8f0b3c6a96bb88e04f5b925007fd0688caf`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/sibling-base-check.mjs:23` — (edge-case, degraded) Multi-commit squash landings remain falsely classified as unlanded
   - Scenario: Squash commits A1 and A2 into main. Leave two descendant lanes open, each retaining A1 and A2 but otherwise containing independent changes. Checking either lane reports two shared unlanded commits because git cherry compares individual commit patches against the combined squash patch. These already-landed changes should not trigger the sibling blocker.
   - Class: correctness-in-normal-use (basis: Read-only git patch-id probes confirmed that two separate file-addition patches and their combined squash have three distinct patch IDs. Feeding the corresponding cherry and ancestry transcript into checkSiblingBase produced count=2.)
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/open-pr-io.mjs:261` — (edge-case, degraded) The audit's main refresh cannot clear an earlier sibling refusal
   - Scenario: Start with stale origin/main that predates an already-landed commit retained by the target and another open lane. Run open-pr --check with a full --sha. The initial sibling check records an overlap; canonicalAudit then refreshes main and returns that same SHA. No sibling recheck occurs, so the request remains refused despite refreshed history proving the shared commit landed. Without an explicit SHA, a clean second check also leaves the earlier blocker accumulated.
   - Class: correctness-in-normal-use (basis: Executed the runner function body with controlled dependencies modeling the audit refresh. With an unchanged full SHA, it performed one sibling read and returned sibling-base after the refresh. The canonical audit implementation refreshes origin/main during --check; collected blockers are never replaced.)
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
