---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xcfikoo-reconcile-we-conformance-level-scales-and-stale-maturity-ref.md", "we:backlog/8629-when-do-github-labels-stop-being-the-source-of-truth.md", "we:backlog/8623-use-one-template-for-every-everstandard.md", "we:backlog/8635-unpause-the-builder-for-stage-1-after-all-four-preconditions.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Require structured Acceptance-to-check references, including named documentation checks for docum… (from web-everything/web-everything#7289 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xcfikoo-reconcile-we-conformance-level-scales-and-stale-maturity-ref.md:24` — Require structured Acceptance-to-check references, including named documentation checks for documentation-only work.
2. `we:backlog/8629-when-do-github-labels-stop-being-the-source-of-truth.md` — Require every prepared must-hold rule to carry an identifier and a named planned check; reject unresolved references deterministically.
3. `we:backlog/8623-use-one-template-for-every-everstandard.md` — Extend the preparation gate to require named positive and negative checks for each conformance or release guarantee, explicitly covering omitted/default values.
4. `we:backlog/8635-unpause-the-builder-for-stage-1-after-all-four-preconditions.md` — Require named planned checks for every activation prerequisite and operator/product default boundary before a preparation card is considered test-mapped.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473, finding 3 → #5636, finding 6 → #5668.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7289@e9d5d574f98e62d0bd46f42c6a881de8a048f2f8

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
