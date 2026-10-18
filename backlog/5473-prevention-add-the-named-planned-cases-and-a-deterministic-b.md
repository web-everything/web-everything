---
bornAs: xpisb03
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5466-revert-red-check-a-fix-push-s-new-tests-must-fail-with-the-f.md", "we:backlog/5469-stable-finding-identity-in-the-ledger-scoped-re-review-in-sh.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add the named planned cases and a deterministic backlog check requiring behavioral guarantees to… (from web-everything/web-everything#4505 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5466-revert-red-check-a-fix-push-s-new-tests-must-fail-with-the-f.md:37` — Add the named planned cases and a deterministic backlog check requiring behavioral guarantees to reference a repository-qualified test file, named case, and observable assertion.
2. `we:backlog/5469-stable-finding-identity-in-the-ledger-scoped-re-review-in-sh.md:24` — Require explicit divergent-result fixtures for shadow policies, and enforce test-reference completeness through a deterministic backlog check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4505@8e9f38aafb352031eb90f919b9a08b518d347c0a

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Also raised by

- Also raised by web-everything/web-everything#5546 (review 2026-10-18, coverage findings on #6242, #6243 and #6244): record the following additional requirements for this future `check:standards` preparation gate. This files the owed prevention; this PR does not implement the gate.
  - Require a machine-checkable mapping from every behavioral guarantee to a repository-qualified planned test file, exact case name in A1, and observable assertion. Behavioral non-goals and edge-case handling must cite that mapping or explicitly say `n/a: <why>`; a testable claim cannot be hidden behind `n/a`.
  - Expand comma-separated `WITH ...` and `facts (...)` lists into individual requirements. Each listed item must map to its own named case or carry an explicit waiver. Negative fixtures must remove red CI, conflict, CodeQL and red-main coverage one at a time while retaining hold:drain coverage, and require rejection.
  - For each enumerated setting, require coverage of every value plus a separate invalid-value case and a default/absent-value case (including missing settings files). A cited settings-schema test may cover enum validation, but not behavioral defaults, provenance or authority precedence.
  - Require settings cards to state precedence against overlapping settings and map it to named cases; cover global labels versus per-fact ledger, global both retaining label holds, every prClass value, unknown/absent prClass, mixed/unclassifiable PRs, and cascade-source logging.
  - For cards loosening a refusal, require both Must lines (errors refuse; non-code input kinds remain cautious) and their test mappings. Include missing, errored, empty and truncated reads independently from invalid settings.
  - Planned lint fixtures must reject each unmapped edge handling, behavioral non-goal, list item, enum value, missing/default case, precedence guarantee and Must line; accept complete mappings and explicit justified nonbehavioral waivers. Include the three ledger-promotion cards as representative fixtures, with assertions for PR/head isolation, append-only existing-file writes, clock reset/digest reporting and unchanged live merge outcomes.
- Also raised by web-everything/web-everything#5160 (finding 1: `we:backlog/5943-red-main-repair-patterns-resolve-host-wide-not-per-caller.md:63` — Add a preparation gate requiring each explicit behavioral guarantee to reference a named planned test and its observable assertion; review that assertion for semantic adequacy.) · key `approval-prevention-key:web-everything/web-everything#5160@bbbcd56e8249ec6895433e4b4959981c9c10eb35`
- Also raised by web-everything/web-everything#5225 (finding 1: `we:backlog/4674-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:27` — Add a preparation gate requiring each behavioral guarantee to map to a repository-qualified planned test, named case, and observable assertion; include omitted settings and override logging explicitly.) · key `approval-prevention-key:web-everything/web-everything#5225@cdaee5662950a8f02789cb92b4b1da765c2ea215`
- Also raised by web-everything/web-everything#5508 (finding 2: `we:backlog/6194-fixer-treats-operator-decisions-scope-baseline-and-main-regr.md:42` — Add a preparation check requiring each behavioral contract to reference a named test and observable assertion; use a transition-coverage review for supersession semantics.)
- Also raised by web-everything/web-everything#5508 (finding 3: `we:backlog/6194-fixer-treats-operator-decisions-scope-baseline-and-main-regr.md:42` — Require each behavioral guarantee to reference a named planned case and observable assertion in a structured coverage table; a preparation lint can reject unmapped guarantee entries.)
- Also raised by web-everything/web-everything#5546 (finding 5: `we:backlog/6242-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md:32` — Add a deterministic card check requiring every behavioral guarantee ID to reference a planned test file, case name, and observable assertion.)
- Also raised by web-everything/web-everything#5546 (finding 13: `we:backlog/6244-ledger-shadow-comparison-counts-the-drain-s-own-facts.md:36` — Add a deterministic guarantee-to-test mapping gate for backlog cards, requiring named planned tests and observable assertions for temporal and failure-path requirements.)
- Also raised by web-everything/web-everything#5524 (finding 3: `we:backlog/6217-prevention-add-a-buildoverlaprows-test-that-sets-module-argv.md:25` — Add a deterministic card-preparation gate requiring each acceptance guarantee to reference a repository-qualified test file, named planned case, and observable assertion before activation.)
- Also raised by web-everything/web-everything#5539 (finding 4: `we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md:26` — Implement the already-proposed backlog gate requiring each Acceptance guarantee to identify a repository-qualified test file, named case, and observable assertion before activation.)
- Also raised by web-everything/web-everything#5576 (finding 1: `we:backlog/6281-prevention-a-check-standards-rule-that-any-conveyor-module-w.md:24` — Add a deterministic backlog-card check requiring each acceptance guarantee to reference a repository-qualified test file, named planned case, and observable assertion, rejecting TODO-only acceptance entries.) · key `approval-prevention-key:web-everything/web-everything#5576@00897d3d3b922552f81cd618b734ffe8daea1c38`
- Also raised by web-everything/web-everything#5549 (finding 14: `we:backlog/xkwhvyg-we-operator-override-slice-1-host-wide-store-and-operator-on.md:34` — Add a deterministic preparation gate requiring every behavioral obligation to reference a repository-qualified test file, named planned case, and observable assertion.)
- Also raised by web-everything/web-everything#5549 (finding 19: `we:backlog/xkwhvyg-we-operator-override-slice-1-host-wide-store-and-operator-on.md:34` — Add a deterministic preparation gate requiring every behavioral guarantee to reference a repository-qualified test file, named planned case, and observable assertion.)
- Also raised by web-everything/web-everything#5564 (finding 2: `we:backlog/6280-prevention-add-a-card-lint-rule-any-card-that-adds-a-layer-t.md:41` — Implement the preparation gate already tracked by #5473: require each acceptance obligation to specify a repository-qualified test file, named planned case, and observable assertion before activation.)
- Also raised by web-everything/web-everything#5580 (finding 4: `we:backlog/5961-labels-a-known-labels-cache-instead-of-label-create-before-e.md:53` — Require each behavioral guarantee to reference a named test and explicit assertion in a structured coverage matrix, with a standards gate rejecting missing mappings.)
- Also raised by web-everything/web-everything#5582 (finding 3: `we:backlog/6290-prevention-have-the-prevention-filer-pre-fill-a1-with-each-o.md:22` — Add a deterministic preparation gate requiring each acceptance item to reference a repository-qualified test file, named planned case, observable assertion, and validation command; related gate debt is already recorded in card #5615, but no implemented gate is shown.)
- Also raised by web-everything/web-everything#5586 (finding 1: `we:backlog/6287-prevention-add-a-check-standards-or-filer-post-condition-tha.md:22` — Implement the preparation gate already tracked by #5473, requiring each behavioral obligation to map to a repository-qualified test file, named planned case, observable assertion, and validation command.) · key `approval-prevention-key:web-everything/web-everything#5586@32478e7d683b7ff226255d3c5d2002db3d0b4faa`
- Also raised by web-everything/web-everything#5586 (finding 2: `we:backlog/6287-prevention-add-a-check-standards-or-filer-post-condition-tha.md:22` — Implement the preparation gate already tracked by #5473, requiring each acceptance guarantee to map to a repository-qualified test file, named planned case, observable assertion, and validation command.)
- Also raised by web-everything/web-everything#5583 (finding 1: `we:backlog/6283-prevention-add-a-card-lint-check-that-every-planned-capabili.md:23` — Implement the preparation gate already tracked by #5473: require each behavioral acceptance obligation to map to a repository-qualified test file, named planned case, and observable assertion.) · key `approval-prevention-key:web-everything/web-everything#5583@f003ae7819db5bd26545f1d8f5b478f9f27a0d00`
- Also raised by web-everything/web-everything#5583 (finding 2: `we:backlog/6283-prevention-add-a-card-lint-check-that-every-planned-capabili.md:23` — Add a deterministic card-preparation gate requiring each behavioral acceptance obligation to map to a repository-qualified test file, named planned case, and observable assertion before activation.)
- Also raised by web-everything/web-everything#5590 (finding 1: `we:backlog/6289-prevention-route-all-three-derive-sites-report-apply-re-deri.md:24` — Implement the deterministic preparation gate already tracked by #5473: require every executable obligation to identify a repository-qualified test file, named implemented or planned case, and observable assertion before activation.) · key `approval-prevention-key:web-everything/web-everything#5590@8f1df3ba73763620b1eb11406a6c59ef363502db`
- Also raised by web-everything/web-everything#5590 (finding 2: `we:backlog/6289-prevention-route-all-three-derive-sites-report-apply-re-deri.md:24` — Apply the deterministic preparation gate tracked by #5473: require each behavioral obligation to identify a repository-qualified test file, named implemented or planned case, and observable assertion. The diff records this guard as backlog debt, not an implemented gate.)
- Also raised by web-everything/web-everything#5550 (finding 3: `we:backlog/6284-ledger-referral-cannot-reopen-after-a-published-clearance-st.md:18` — Add a deterministic backlog check requiring executable Acceptance entries to specify a repository-qualified test file and named case, allowing an explicit planned designation.)
- Also raised by web-everything/web-everything#5550 (finding 4: `we:backlog/6285-operator-clearing-ruling-can-end-under-a-stale-mandatory-blo.md:18` — Use the same deterministic Acceptance check requiring a repository-qualified test file and named implemented or planned case.)
- Also raised by web-everything/web-everything#5550 (finding 6: `we:backlog/6284-ledger-referral-cannot-reopen-after-a-published-clearance-st.md:18` — Require Acceptance entries to identify a repository-qualified test file, named case, and observable assertion; validate those references when implementing the card.)
- Also raised by web-everything/web-everything#5550 (finding 7: `we:backlog/6285-operator-clearing-ruling-can-end-under-a-stale-mandatory-blo.md:18` — Require Acceptance entries to identify a repository-qualified test file, named case, and observable assertion; validate those references when implementing the card.)
- Also raised by web-everything/web-everything#5573 (finding 1: `we:backlog/6286-prevention-have-the-filer-seed-a1-with-the-specific-failing.md:25` — Implement the already-tracked deterministic preparation gate requiring each behavioral obligation to map to a repository-qualified planned test file, named case, and observable assertion before activation.) · key `approval-prevention-key:web-everything/web-everything#5573@ddf0994363a52be8596f8bc7f8128a31c519de53`
