---
bornAs: xejj3dd
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md", "we:reports/2026-10-25-probation-registry-generalisation.md", "we:backlog/xezensp-prevention-decision-preparation-coverage-and-citation-checks.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Extend the xezensp guarantee-manifest gate (Done when 2) so that any "only X may do Y" sentence r… (from web-everything/web-everything#5932 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md` — Extend the xezensp guarantee-manifest gate (Done when 2) so that any "only X may do Y" sentence requires a mapped test with a refusal assertion for a non-X actor, not only a success assertion for X.
2. `we:reports/2026-10-25-probation-registry-generalisation.md:57` — Extend the normative-guarantee mapping gate tracked by #7199 to include linked research reports and require an observable assertion for absent criteria.
3. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:37` — Require each edge-case guarantee to map to a named test with an assertion on the promised behavior, including execution and write side effects.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5932@f63e2345fa010188a607d5ec99baec184ba16f77

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
