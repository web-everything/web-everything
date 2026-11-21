---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/build-priority-set.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7268 (head e7c6938c0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7268 (reviewed head `e7c6938c0df2f0d3e9f7d6dc79f6f8c036b17c3b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/build-priority-set.mjs:23` — (edge-case, degraded) Leading-zero IDs validate successfully but receive no priority
   - Scenario: Use --ids=06893 --mode=lift --ttl-hours=2 --actor=operator --reason=probe for existing card 6893. Card lookup accepts the numeric identity, but the proposed runtime record preserves '06893'. After round-tripping through readBuildPrioritySettings, orderQueueDetailed gives card 6893 a null priority index. Canonical '6893' gives index 0 and lifts it above other cards. Accepted IDs must be canonicalized before storage, or padded spellings must be refused.
   - Class: live-reproduced (basis: Executed the preview using the actual card reader with injected git responses for we:backlog/6893-example.md. Round-tripped its record through the runtime reader and queue ordering: '06893' failed to lift card 6893, while '6893' lifted it.)
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
