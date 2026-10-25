---
bornAs: x18sjv3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6411-prevention-add-a-table-driven-test-or-soak-break-that-replay.md", "we:backlog/6413-prevention-give-the-shared-helper-two-named-predicates-one-f.md", "we:backlog/6414-prevention-add-an-integration-test-that-runs-strict-scanlane.md", "we:backlog/6415-prevention-a-memory-write-check-that-when-a-new-memory-menti.md", "we:backlog/6416-red-team-follow-ups-from-web-everything-web-everything-5507.md", "we:backlog/6417-red-team-follow-ups-from-web-everything-web-everything-5472.md", "we:backlog/6418-prevention-add-fixture-tests-where-the-finding-s-scenario-co.md", "we:backlog/6419-prevention-have-readcodexquota-return-the-source-path-and-mt.md", "we:backlog/6420-prevention-when-a-default-policy-changes-a-lint-or-test-that.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Use the deterministic obligation-to-test mapping gate filed in #5360/#5473, including separate om… (from web-everything/web-everything#5674 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6411-prevention-add-a-table-driven-test-or-soak-break-that-replay.md:16` — Use the deterministic obligation-to-test mapping gate filed in #5360/#5473, including separate omitted-setting and invalid-setting cases where applicable.
2. `we:backlog/6413-prevention-give-the-shared-helper-two-named-predicates-one-f.md:16` — Apply the deterministic mapping gate filed in #5360/#5473 to each independently numbered behavioral obligation.
3. `we:backlog/6414-prevention-add-an-integration-test-that-runs-strict-scanlane.md:16` — Implement the mapping gate filed in #5360/#5473 so generic test requests cannot substitute for named cases and assertions.
4. `we:backlog/6415-prevention-a-memory-write-check-that-when-a-new-memory-menti.md:16` — Use the mapping gate filed in #5360/#5473 to require named positive and negative cases for newly proposed validation rules.
5. `we:backlog/6416-red-team-follow-ups-from-web-everything-web-everything-5507.md:16` — Apply the mapping gate filed in #5360/#5473, requiring separate named cases for each recorded failure and explicit assertions for isolated degradation.
6. `we:backlog/6417-red-team-follow-ups-from-web-everything-web-everything-5472.md:16` — Use the mapping gate filed in #5360/#5473 and require configuration-validation cases to identify whether overrides are absent or present.
7. `we:backlog/6418-prevention-add-fixture-tests-where-the-finding-s-scenario-co.md:16` — Implement the mapping gate filed in #5360/#5473, rejecting descriptive test references without a case name and observable assertion.
8. `we:backlog/6419-prevention-have-readcodexquota-return-the-source-path-and-mt.md:16` — Apply the mapping gate filed in #5360/#5473, requiring named boundary cases and assertions for conditional recording guarantees.
9. `we:backlog/6420-prevention-when-a-default-policy-changes-a-lint-or-test-that.md:16` — Implement the mapping gate filed in #5360/#5473/#5668, requiring separate omitted-setting cases and named mappings for each publication effect.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5674@ae2fc09e453988446411c153aba80907838dd96d

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
