---
bornAs: xj7rxkg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6200-gate-active-delivery-cards-on-complete-executable-acceptance.md", "we:backlog/6203-wire-the-delivery-metrics-collector-as-a-daily-health-watch.md", "we:backlog/6201-delivery-metrics-collector-a-daily-snapshot-of-delivery-meas.md", "we:backlog/6202-delivery-dashboard-a-delivery-page-in-plateau-app-charting-t.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add to the 6200 test plan: leavesResolvedCardsUntouched and neverExecutesAcceptanceCommands (spy… (from web-everything/web-everything#5505 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6200-gate-active-delivery-cards-on-complete-executable-acceptance.md:26` — Add to the 6200 test plan: `leavesResolvedCardsUntouched` and `neverExecutesAcceptanceCommands` (spy on child_process). Long term, a lint that each edge-case-to-case reference names an assertion mentioning the claim.
2. `we:backlog/6203-wire-the-delivery-metrics-collector-as-a-daily-health-watch.md:9` — File a card for #5487 and add it to blockedBy, or keep 6203 `open` until it lands. Gate: the 6200 overlapping-scope lint should also cover open PRs' files.
3. `we:backlog/6201-delivery-metrics-collector-a-daily-snapshot-of-delivery-meas.md:38` — Require structured byte-budget or read-range assertions for bounded-reader guarantees in the planned card-contract gate, backed by a counting-reader fixture.
4. `we:backlog/6201-delivery-metrics-collector-a-daily-snapshot-of-delivery-meas.md:37` — Require isolation mappings to identify both the failed output and an unaffected output assertion; enforce those structured fields in the planned card-contract gate.
5. `we:backlog/6200-gate-active-delivery-cards-on-complete-executable-acceptance.md:32` — Add a deterministic active/resolved fixture matrix to the standards suite, requiring identical legacy content to receive different outcomes according to the declared policy boundary.
6. `we:backlog/6200-gate-active-delivery-cards-on-complete-executable-acceptance.md:33` — Extend the contract-checking follow-up in card 6200 to require structured risk-to-case/assertion mappings; include paired active/resolved fixtures for lifecycle exemptions.
7. `we:backlog/6201-delivery-metrics-collector-a-daily-snapshot-of-delivery-meas.md:39` — Use card 6200's structured guarantee mappings to require explicit preserved-output assertions for isolated degradation claims, with semantic review of those assertions.
8. `we:backlog/6202-delivery-dashboard-a-delivery-page-in-plateau-app-charting-t.md:30` — Extend card 6200's structured coverage contract so bounded-read guarantees require a byte-count or read-range assertion, backed by an instrumented reader fixture.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5505@440cd1c4c18c773d1669189862322e9d0153b7b7

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
