---
kind: story
size: 2
status: open
scope: ["we:blocks/sectioned-nav/SectionedNav.ts", "we:blocks/app-shell/AppShell.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user, correctness-in-normal-use] from frontier-ui/frontierui#57 (head cee714ff8)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#57 (reviewed head `cee714ff86e0a2e4563d50378374e10840eeff26`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/sectioned-nav/SectionedNav.ts:146` — (edge-case, degraded) Removing a compact item can eliminate every connected tab stop
   - Scenario: Create compact items A, B and C, remove A from the DOM, focus B, then press Home. The captured anchors array assigns tabindex=0 to detached A and tabindex=-1 to B and C; focus remains on B. After leaving, keyboard users cannot Tab back into the nav. Home should target the first remaining available item and preserve a connected tab stop.
   - Class: live-reproduced (basis: An in-memory Happy DOM probe executing the transpiled factory confirmed detached A receives tabindex=0 while both remaining links receive -1.)
   - Also class: attacker-same-user
   - Claude's re-check: demonstrated break
2. `we:blocks/app-shell/AppShell.ts:173` — (failing-input, degraded) Custom shell tags never receive the responsive grid layout
   - Scenario: Register registerAppShell('product-shell'), append that element, and configure both nav and compactNav at 1280px. Band wiring selects wide and hides the compact nav, but the grid declaration targets only literal we-app-shell elements or shadow hosts. The custom light-DOM shell therefore stacks its side nav and main instead of providing the promised 220px sidebar. The responsive root rules should support the public custom-tag registration path.
   - Class: correctness-in-normal-use (basis: registerAppShell explicitly supports consumer-selected tags. Selector inspection confirms the new light-DOM grid rule excludes those tags; :host does not match in document-level stylesheets.)
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
