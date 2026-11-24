---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/open-pr-io.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7431 (head e1e85d12f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7431 (reviewed head `e1e85d12fa7c6676299f85f798118372202c4bcc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/open-pr-io.mjs:268` — (edge-case, degraded) A successful sibling recheck cannot clear a blocker recorded before main was refreshed.
   - Scenario: Local origin/main is stale, and the proposed branch and another open PR share a commit already landed on remote main. The first sibling check records an overlap. During --check, canonicalAudit refreshes main; the second sibling check now passes, but the earlier blocker remains in blockers, so the runner still refuses. The result should reflect the successful check against refreshed main. A runner probe returning overlap before audit refresh and an empty result afterward still returned sibling-base.
   - Class: live-reproduced (basis: Executed the real runner with injected audit and sibling IO. Both checks ran in order, the second passed, and the final result retained the first refusal. The production audit explicitly refreshes main during --check.)
   - Also class: correctness-in-normal-use
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
