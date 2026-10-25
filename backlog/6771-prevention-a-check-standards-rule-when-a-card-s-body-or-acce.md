---
bornAs: xqes9kp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md", "we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md", "we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — A check:standards rule: when a card's body or acceptance names another card's module or export as… (from web-everything/web-everything#5549 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:1` — A check:standards rule: when a card's body or acceptance names another card's module or export as a dependency, that card must appear in blockedBy, and the reverse edge must not form a dependency cycle. This extends the guard-floor and cycle lint in backlog/6311.
2. `we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md:6` — A lint that every file an acceptance test must fix on failure is in the card's scope, or a single-source key registry owned by the slice that wires the resolvers.
3. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:47` — File a card to enumerate host credential sources in the red-team checklist for authority cards. A lint cannot decide this, so it stays a review lens.
4. `we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md:17` — Add a 'path-safe identity' line to the card edge-case template, enforced by the x3g7q2m mapping lint.
5. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:35` — Extend the acceptance-coverage template and lint fixtures to require an explicit omitted-input test reference for each declared behavioral default.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5549@71839eecaa6b3bc9954edb4b10a7fe9834d6daf1

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
