---
bornAs: xadunn9
kind: story
size: 1
status: open
dateOpened: "2026-10-08"
tags: []
---

# /wip deep links: ?card=N highlights a card, ?agent=<session> opens its agent panel (P3 of 128)

Requested behavior: /wip?card=N scrolls to, highlights and focuses the card; /wip?agent=<session> opens the matching agent panel. Unknown identities show an inline notice. The original scope points outside WE; no matching WIP mount or mount test was found in this checkout. Scope is omitted pending an ownership ruling.

## Done when

- [A1] Executable criterion blocked: there is no verified WE mount test path for this surface. After the ownership question is answered, name the real owning-repo test and queue command; it must cover known card focus/highlight, known session panel, and unknown card/session notice. Inventing a we:-prefixed implementation/test path would misrepresent the checkout.

## Non-goals

- [N1] No implementation in the abandoned prototype, new session-control action, or feed mutation. Links select existing UI state; no new write endpoint, so body/rate/CSRF controls are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Parse query values as opaque IDs; render unknown-ID notices as text, never HTML or raw selectors.
2. **Truncated reads** — If the card/session feed is incomplete, show loading/unavailable rather than declaring a missing identity.
3. **Shared state files** — n/a: navigation should not write shared card/session state.
4. **Fail closed** — A missing or unauthorized session must not open another panel or trigger a control action.
5. **Identity scoping** — Resolve the exact card/session within the loaded authorized surface, not a substring match.
6. **State over time** — Wait for async mount/data before resolving; clear obsolete highlights when query/navigation changes.
7. **Who wrote it** — A URL selects a target; it does not prove the linker owns the session or authorize session actions.

## Grounding

`we:vite.config.mts:12` imports the sibling product’s dev panel, not a WE WIP mount. `we:backlog/128-background-task-status-bar-block.md:13` concerns a background-task block, not the claimed P3 parent. File enumeration found no WIP/glance mount or associated test in WE.

## Open questions

Which live product repo and existing mount/test own this feature, and what is the actual parent card? The original non-WE scope conflicts with the requested we:-only scope. This blocks a truthful executable acceptance test and implementation estimate; size 1 is retained provisionally.
