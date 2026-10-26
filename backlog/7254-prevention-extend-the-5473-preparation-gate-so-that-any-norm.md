---
bornAs: xnfrapc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Extend the #5473 preparation gate so that any normative "no X option / cannot be disabled" clause… (from web-everything/web-everything#5953 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:43` — Extend the #5473 preparation gate so that any normative "no X option / cannot be disabled" clause needs a mapped case. That is the same rule as the self-referential Done-when check, applied to its own prose.
2. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:38` — Add a review-lens checklist item for tools that dereference author-supplied paths (confine to the repo root, reject symlink escapes, test each). Longer term, make a shared path-confinement helper a standards-checked dependency.
3. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:71` — Have the manifest gate treat "n/a" edge-case dispositions that make a negative claim as claims needing a case or an explicit "not tested" marker.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 4 → #xg637ec.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5953@bb7efb874ab0e04c2742faa9c04533ee18ec1e08

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
