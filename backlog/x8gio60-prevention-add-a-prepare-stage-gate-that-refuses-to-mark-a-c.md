---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xrf4ker-pd-fui-1-time-tracks-block-we-time-tracks.md", "we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md", "we:backlog/xr0qe34-pd-fui-2-milestone-flags-we-milestone-flag.md", "we:backlog/xksajth-pd-fui-3-status-card-with-source-word-tag-we-status-card.md", "we:backlog/xqganip-pd-fui-6-rung-navigation-we-rung-nav.md", "we:backlog/xnpd8wr-pd-fui-7-heat-strip-we-heat-strip.md"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a prepare-stage gate that refuses to mark a card prepared while [A1] still contains the TODO… (from web-everything/web-everything#7354 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xrf4ker-pd-fui-1-time-tracks-block-we-time-tracks.md:16` — Add a prepare-stage gate that refuses to mark a card prepared while [A1] still contains the TODO placeholder; file-item should seed [A1] from a 'Tier-1 test:' sentence when one is present.
2. `we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md:490` — Derive the 'N cards' figure from the SOURCES list or add an assertion in CarriedSourceFidelity comparing the stated count to len(SOURCES).
3. `we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md:7` — Add a check:standards rule for `close --into` merges: the carried card's scope must be a superset of the closed cards' scopes, or the omission must be named explicitly.
4. `we:backlog/xr0qe34-pd-fui-2-milestone-flags-we-milestone-flag.md:13` — Gate prepared cards on acceptance-to-test mappings, requiring distinct omitted/default and explicit-value cases for policy defaults.
5. `we:backlog/xksajth-pd-fui-3-status-card-with-source-word-tag-we-status-card.md:12` — Require acceptance-to-named-test mappings at preparation and a deterministic style check for prohibited animation and colour usage.
6. `we:backlog/xqganip-pd-fui-6-rung-navigation-we-rung-nav.md:12` — Require named acceptance mappings and contrasting non-default fixtures whenever a card promises configuration-driven behavior.
7. `we:backlog/xnpd8wr-pd-fui-7-heat-strip-we-heat-strip.md:13` — Gate preparation on complete acceptance-to-named-test mappings and use static checks for mechanically detectable presentation prohibitions.
8. `we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md:21` — Extend the deterministic cleanup validator to compare absorbed prerequisite unions and an explicit manifest of expected status, duplicate target and parking metadata.
9. `we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md:14` — Require a deterministic acceptance-to-test mapping check at preparation completion, distinguishing source-preservation tests from tests of the carried product behavior.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 4 → #5078, finding 5 → #5473, finding 8 → #5473, finding 9 → #5473, finding 12 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7354@f8984768b5c3e8f3d486a85f0bd1f86febd16bf1

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
