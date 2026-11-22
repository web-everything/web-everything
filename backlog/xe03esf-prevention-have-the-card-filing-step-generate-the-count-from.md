---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/8684-ui-requirements-carried-from-closed-wip-cards.md", "we:backlog/8686-pd-fui-3-status-card-with-source-word-tag-we-status-card.md", "we:backlog/8688-pd-fui-6-rung-navigation-we-rung-nav.md", "we:backlog/8689-pd-fui-1-time-tracks-block-we-time-tracks.md", "we:backlog/8690-pd-fui-7-heat-strip-we-heat-strip.md", "we:backlog/8691-pd-fui-2-milestone-flags-we-milestone-flag.md"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Have the card-filing step generate the count from the same list that emits the carried blocks, or… (from web-everything/web-everything#7354 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/8684-ui-requirements-carried-from-closed-wip-cards.md:97` — Have the card-filing step generate the count from the same list that emits the carried blocks, or add a check:standards rule that compares the 'N cards' claim to the number of '### Carried from #' headings.
2. `we:backlog/8686-pd-fui-3-status-card-with-source-word-tag-we-status-card.md:13` — Gate preparation on acceptance-to-named-test mappings, using deterministic style checks for forbidden colors, animation and implementation size.
3. `we:backlog/8688-pd-fui-6-rung-navigation-we-rung-nav.md:13` — Require named acceptance mappings and an explicit nondefault fixture whenever acceptance promises configuration-driven behavior.
4. `we:backlog/8689-pd-fui-1-time-tracks-block-we-time-tracks.md:13` — Gate preparation on named acceptance mappings; enforce forbidden CSS constructs and implementation size through deterministic checks.
5. `we:backlog/8690-pd-fui-7-heat-strip-we-heat-strip.md:14` — Require named acceptance mappings and distinct nondefault target fixtures; add deterministic checks for prohibited visual patterns where feasible.
6. `we:backlog/8691-pd-fui-2-milestone-flags-we-milestone-flag.md:14` — Require named acceptance mappings and separate omitted, disabled and enabled fixtures for policy defaults, plus a deterministic implementation-size check.
7. `we:backlog/8684-ui-requirements-carried-from-closed-wip-cards.md:15` — Require a structured acceptance-to-test mapping at implementation preparation, distinguishing source-preservation tests from behavioral tests and rejecting unresolved test-name placeholders.
8. `we:backlog/8684-ui-requirements-carried-from-closed-wip-cards.md:7` — Extend the deterministic consolidation validator to compare source dependency unions, duplicate destinations, parent identity and the explicitly requested parked metadata.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5039, finding 3 → #5605, finding 4 → #6216, finding 5 → #5473, finding 12 → #5473, finding 7 → #5636.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7354@1ef81e6aa1f83ba59c527241b92ee7a781bc90dc

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
