---
bornAs: xhsszyn
kind: story
size: 2
status: open
scope: ["we:scripts/lib/build-queue.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5038 (head 0b4c71b41)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5038 (reviewed head `0b4c71b41d41e306a7d4a4781512de8aca68b674`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/build-queue.mjs:28` — (failing-input, degraded) Accepted zero-padded card numbers silently fail to apply build priority.
   - Scenario: Use two open, build-cleared cards: num='001', dateOpened='2020-01-01'; and num='002', dateOpened='2026-10-12'. Resolve WE_BUILD_PRIORITY='002' and pass the resulting ids into orderQueueDetailed. A read-only Node probe returned accepted settings {ids:['002'],source:'env'}, but ordered ['001','002'], with both buildPriorityIndex values null. Changing only the environment value to '2' correctly ordered ['002','001']. normalizeBuildPriority preserves leading zeros while buildPriorityAliases strips them, so the accepted priority cannot match even the card's own canonical padded number. Normalize nu
   - Claude's re-check: Confirmed from the diff. normalizeBuildPriority accepts '002' via /^\d+$/ and only trims it, so the key stays '002' in the priorityIds map. buildPriorityAliases strips leading zeros from item.num, so card '002' only yields the alias '2'. ids.get('2') misses the '002' key. The id's own x-id stem and bornAs aliases don't apply, so a zero-padded priority never matches and is silently ignored. Priority '2' does match.

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

## Also raised by

- Also raised by web-everything/web-everything#5038 (finding 1: `we:scripts/lib/build-queue.mjs:28` — failing-input, degraded Canonical zero-padded numeric IDs silently lose their build priority.)
