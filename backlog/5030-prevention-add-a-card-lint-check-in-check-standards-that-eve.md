---
bornAs: xqw9oa1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4992-configurable-overlap-strategy-for-pr-repairs-stack-on-the-pr.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a card-lint check in check:standards that every 'Tests:' clause in a Design item resolves to… (from web-everything/web-everything#3853 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4992-configurable-overlap-strategy-for-pr-repairs-stack-on-the-pr.md:37` — Add a card-lint check in check:standards that every 'Tests:' clause in a Design item resolves to a file listed in scope and in the Done-when command; until that exists, a review-lens note.
2. `we:backlog/4992-configurable-overlap-strategy-for-pr-repairs-stack-on-the-pr.md:33` — Review-lens note: when a card adds a setting, grep the card for the existing field-count or enumeration and update it. A deterministic gate is not practical for prose counts.
3. `we:backlog/4992-configurable-overlap-strategy-for-pr-repairs-stack-on-the-pr.md:37` — Add an acceptance-criteria line and a test that any head change not initiated by our restack, native or not, invalidates review and CI evidence and holds the child. Also state that the adapter is limited to base-setting and linking, with no provider merge or rebase actions. A review-lens checklist item for provider adapters is the cheapest durable guard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3853@cadece54da44b7da58cd9e5e83d633192a7e115c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
