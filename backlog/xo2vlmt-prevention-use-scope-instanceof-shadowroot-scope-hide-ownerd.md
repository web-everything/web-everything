---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/app-shell/AppShell.ts", "we:blocks/sectioned-nav/SectionedNav.ts", "we:blocks/__tests__/unit/app-shell/responsive.test.ts", "we:blocks/__tests__/unit/sectioned-nav/compact.test.ts", "we:blocks/app-shell/__tests__/AppShell.test.mjs", "we:blocks/sectioned-nav/__tests__/SectionedNav.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Use (scope instanceof ShadowRoot ? scope : hide.ownerDocument).activeElement, and parametrise the wireShel… (from frontier-ui/frontierui#57 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/app-shell/AppShell.ts:196` — Use `(scope instanceof ShadowRoot ? scope : hide.ownerDocument).activeElement`, and parametrise the wireShellBands tests over light and shadow hosts.
2. `we:blocks/sectioned-nav/SectionedNav.ts:161` — Return early when altKey, ctrlKey or metaKey is set, and add a test for it. A shared roving-tabindex helper would hold the guard in one place.
3. `we:blocks/__tests__/unit/app-shell/responsive.test.ts:94` — Add a scoped regex for `[data-band="narrow"] > .fui-app-shell__main[^}]*padding-bottom[^}]*safe-area-inset-bottom`. For layout guarantees, prefer a browser (Tier-2) computed-style check over CSS string matching.
4. `we:blocks/__tests__/unit/sectioned-nav/compact.test.ts:34` — Add deterministic assertions for both a non-first current item and the no-current fallback to the unit-test gate.
5. `we:blocks/__tests__/unit/app-shell/responsive.test.ts:77` — Add a named unit test asserting that generated navigation items contain only label text and the permitted badge, and include it in the unit-test gate.
6. `we:blocks/app-shell/AppShell.ts` — Parameterize the nested-shell isolation test across light and shadow mounts and require it in the unit-test gate.
7. `we:blocks/app-shell/AppShell.ts` — Gate focus-transfer behavior with parameterized light/shadow tests in both resize directions.
8. `we:blocks/__tests__/unit/sectioned-nav/compact.test.ts` — Add table-driven initial-tab-stop assertions covering non-first current items and the absent-current fallback to the required unit suite.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#57@b0b7568b1942107353a4b28e499230e6abd3155a

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
