---
bornAs: xt4tbi5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5658-review-daemon-promotes-a-green-draft-and-dispatches-its-revi.md", "we:backlog/5653-health-smell-when-an-operator-only-hold-on-a-pr-passes-an-ag.md", "we:backlog/5661-coroner-reads-each-daemon-s-live-log-not-the-dead-fix-daemon.md", "we:backlog/5672-lane-pool-acquirable-scan-takes-100-s-inside-the-builder-vs.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a deterministic card gate requiring each behavioral constraint to reference a repository-qual… (from web-everything/web-everything#4683 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5658-review-daemon-promotes-a-green-draft-and-dispatches-its-revi.md` — Add a deterministic card gate requiring each behavioral constraint to reference a repository-qualified planned test, case name, and observable assertion.
2. `we:backlog/5653-health-smell-when-an-operator-only-hold-on-a-pr-passes-an-ag.md` — Gate cards on explicit constraint-to-test mappings, including separate omitted, malformed, and explicit setting cases whenever default behavior is specified.
3. `we:backlog/5661-coroner-reads-each-daemon-s-live-log-not-the-dead-fix-daemon.md` — Require a machine-checkable constraint-to-planned-test table for backlog cards, including test path, case name, and observable assertion.
4. `we:backlog/5672-lane-pool-acquirable-scan-takes-100-s-inside-the-builder-vs.md` — Gate behavioral constraints on named planned tests and assertions, requiring invalidation and concurrent-state-change cases for shared-cache cards.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4683@4db30ba5980cdbec68f8743238d4d3898340b3f6

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

## Also raised by

- Also raised by web-everything/web-everything#4822 (finding 3: `we:backlog/5785-one-event-stream-and-one-state-manager-for-all-daemons-the-o.md` — Add a deterministic preparation gate requiring each behavioral constraint to reference a repository-qualified planned test, named case, and observable assertion; implementation slices must resolve those references to executable tests.)
- Also raised by web-everything/web-everything#5432 (finding 1: `we:backlog/5960-pass-daemons-self-sync-onto-adopted-code-like-the-other-daem.md:55` — Add a preparation write-gate requiring each new behavioral constraint to reference a repository-qualified planned test, case name, and observable assertion.) · key `approval-prevention-key:web-everything/web-everything#5432@fb485e23a96fb24c3a113ab661e125b3c2dd22fb`
- Also raised by web-everything/web-everything#5469 (finding 1: `we:backlog/6184-build-failure-ledger-release-legacy-exhausted-lookup-outage.md:17` — Require behavioral acceptance constraints to reference a repository-qualified planned test, case name, and observable assertion; gate missing mappings in backlog validation and review their semantic adequacy.) · key `approval-prevention-key:web-everything/web-everything#5469@f37d9162778276100124c243aa7cb78619c2a0ed`
- Also raised by web-everything/web-everything#5503 (finding 1: `we:backlog/6197-default-rulings-for-needs-you-cap-held-breaks-and-the-human.md:81` — Add a deterministic decision-card gate requiring a Test plan with repository-qualified test files, named planned cases, and observable assertions for each behavioral constraint in Risks; file this gate as follow-up work.) · key `approval-prevention-key:web-everything/web-everything#5503@1a8d23078ce50aa7bac9295f8ecf31afeed58ac0`
- Also raised by web-everything/web-everything#5536 (finding 5: `we:backlog/6228-drain-prestage-cached-admission-must-not-survive-changes-to.md:16` — Add a deterministic card-readiness gate requiring each acceptance item to reference a repository-qualified planned test, case name, and observable assertion, rejecting TODO acceptance entries before implementation begins.)
- Also raised by web-everything/web-everything#5536 (finding 6: `we:backlog/6229-fix-scope-fence-human-review-send-back-header-must-not-disab.md:16` — Add a deterministic card-readiness gate requiring each acceptance item to reference a repository-qualified planned test, case name, and observable assertion, rejecting TODO acceptance entries before implementation begins.)
- Also raised by web-everything/web-everything#5513 (finding 3: `we:backlog/6209-red-team-setting-redteam-speculativebrief-independent-specul.md:16` — Add a deterministic preparation gate requiring each behavioral acceptance or risk constraint to reference a repository-qualified test file, a named planned test, and its observable assertion before a card becomes implementation-ready; reject unresolved Acceptance placeholders at that transition.)
- Also raised by web-everything/web-everything#5528 (finding 6: `we:backlog/6224-catch-up-fast-drains-skip-a-pr-still-held-on-the-same-head.md:20` — Gate cards on named, repository-qualified planned tests and assertions for each guarantee; require separate omitted-setting and explicit-setting cases whenever a behavioral default is specified.)
- Also raised by web-everything/web-everything#5528 (finding 9: `we:backlog/6224-catch-up-fast-drains-skip-a-pr-still-held-on-the-same-head.md:16` — Require structured guarantee-to-test mappings in card validation, including separate absent-setting and explicit-setting cases whenever a behavioral default is specified.)
- Also raised by web-everything/web-everything#5598 (finding 3: `we:backlog/6293-nightly-coroner-calls-coroner-false-findings-with-options-it.md:16` — Gate cards on explicit behavioral-constraint mappings to repository-qualified test files, named planned cases, and observable assertions, allowing a justified non-applicability entry for irrelevant template constraints.)
- Also raised by web-everything/web-everything#5613 (finding 1: `we:backlog/6299-we-skip-ci-heal-and-fix-launches-that-cannot-change-anything.md:18` — Add a deterministic card gate requiring behavioral guarantee IDs to reference repository-qualified planned test files, case names, and observable assertions; review assertion adequacy separately.) · key `approval-prevention-key:web-everything/web-everything#5613@84bda424c0c6adca26b7ecf6f6ef50a2ba421f43`
- Also raised by web-everything/web-everything#5625 (finding 1: `we:backlog/6303-operator-override-apply-time-freshness-cannot-be-bypassed-by.md:16` — Add a deterministic backlog-card check requiring behavioral constraint IDs to map to repository-qualified test files, explicit planned case names, and observable assertions; file this guard as future work.) · key `approval-prevention-key:web-everything/web-everything#5625@52641f5fd8cad5f17f86f5c874baa6b07e5237ca`
- Also raised by web-everything/web-everything#5683 (finding 1: `we:backlog/6521-prevention-gate-card-readiness-on-explicit-acceptance-to-tes.md:22` — Implement the deterministic readiness check tracked by cards #5668 and #5590, requiring each behavioral criterion to name a repository-qualified test file, case, and observable assertion before readiness.) · key `approval-prevention-key:web-everything/web-everything#5683@a229f7d8461cfaa1df6bc779591d73b31ec538cf`
- Also raised by web-everything/web-everything#5683 (finding 1: `we:backlog/6521-prevention-gate-card-readiness-on-explicit-acceptance-to-tes.md:22` — Implement the deterministic readiness check tracked by cards #5668 and #5590, requiring each behavioral criterion to name a repository-qualified test file, case, and observable assertion before readiness.) · key `approval-prevention-key:web-everything/web-everything#5683@a229f7d8461cfaa1df6bc779591d73b31ec538cf`
- Also raised by web-everything/web-everything#5649 (finding 1: `we:backlog/6470-prevention-cards-stop-editing-the-shared-parent-card-the-par.md:16` — Add a deterministic card-readiness gate requiring each behavioral acceptance criterion to reference a repository-qualified planned test, named case, and observable assertion.)
