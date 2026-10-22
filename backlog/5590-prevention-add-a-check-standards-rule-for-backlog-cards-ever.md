---
bornAs: x0y2dzv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md", "we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md", "we:backlog/5596-supersede-rule-rewrite-marker-line-re-without-super-linear-b.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule for backlog cards. Every edge-case line that is not 'n/a:' must cite a… (from web-everything/web-everything#4616 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md:35` — Add a check:standards rule for backlog cards. Every edge-case line that is not 'n/a:' must cite an acceptance id (e.g. '[A4]').
2. `we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md:28` — Use the same card-lint rule: a non-n/a untrusted-text edge case must reference an acceptance id.
3. `we:backlog/5596-supersede-rule-rewrite-marker-line-re-without-super-linear-b.md:34` — Use the same card-lint rule: each non-n/a edge-case line must reference an acceptance id.
4. `we:backlog/5592-a-ruling-or-send-back-clears-the-stale-review-status-needs-h.md:34` — Require each behavioral edge-case constraint to reference a planned test case and observable assertion through a backlog validation gate.
5. `we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md:34` — Require separately stated behavioral constraints to map to planned named cases and assertions in backlog validation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4616@209864d02eaf9b3c99bee68e5410adb68de23433

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

- Also raised by web-everything/web-everything#5611 (correctness/COVERAGE: `we:backlog/6305-we-file-claims-last-until-the-pr-merges-or-closes-overlappin.md` — Add a deterministic card-validation gate requiring every behavioral edge-case requirement to reference a repository-qualified planned test file, named case, and observable assertion. Reject a card when any of those three fields is absent; add negative fixtures for each omission and a positive fixture with all three.)
- Also raised by web-everything/web-everything#5525 (finding 2: `we:backlog/6240-overlap-yield-known-holds.md:43` — Card-lint gate: each Edge case item must map to an Acceptance ID.)
- Also raised by web-everything/web-everything#5531 (finding 2: `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md:35` — Same card-lint rule as above: any Acceptance reference to a test must use a named [A<n>] case that appears in the Test plan.)
- Also raised by web-everything/web-everything#5525 (finding 1: `we:backlog/6240-overlap-yield-known-holds.md:28` — Add a check:standards rule requiring every backlog Acceptance line marked Executable to cite a test file and a test name, or planned: <name> .)
- Also raised by web-everything/web-everything#5546 (finding 1: `we:backlog/6242-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md:18` — A card-lint gate in check:standards requiring every non-n/a edge-case line to cite a test name that also appears in an [A#] tests list.)
- Also raised by web-everything/web-everything#5546 (finding 8: `we:backlog/6244-ledger-shadow-comparison-counts-the-drain-s-own-facts.md:35` — Require every behavioral edge-case ID to map to a named planned test and observable assertion through a deterministic card check.)
- Also raised by web-everything/web-everything#5546 (finding 12: `we:backlog/6243-gradual-ledger-authority-per-fact-type-and-pr-class.md:32` — Require each behavioral edge-case ID to reference a named planned test, its repository-qualified file, and an observable assertion through a deterministic backlog validation gate.)
- Also raised by web-everything/web-everything#5525 (finding 1: `we:backlog/6240-overlap-yield-known-holds.md:24` — Add a check:standards rule that fails a card when an edge-case or non-goal guarantee has no Acceptance or Test plan line naming a test file and case. A card-gate item for this class already exists backlog 5668 .)
- Also raised by web-everything/web-everything#5649 (finding 2: `we:backlog/6470-prevention-cards-stop-editing-the-shared-parent-card-the-par.md:17` — Require repository-qualified test files, named cases, and observable assertions for behavioral acceptance criteria through a deterministic card-readiness gate.)
- Also raised by web-everything/web-everything#5613 (finding 2: `we:backlog/6300-we-trim-the-codex-fixer-brief-and-sandbox.md:18` — Require each behavioral guarantee to map to a named planned case and observable assertion through a deterministic card-schema check, including lifecycle and permission-boundary guarantees.)
- Also raised by web-everything/web-everything#5632 (finding 3: `we:backlog/6348-a-later-ordinary-acceptance-must-not-bypass-the-disabled-hum.md:12` — Require a planned test file, named case, and asserted outcome for every behavioral criterion through card validation.)
- Also raised by web-everything/web-everything#5632 (finding 5: `we:backlog/6350-migratelegacyruns-link-and-eexist-paths-have-a-real-test.md:12` — Require coverage cards to declare planned test files, case names, and assertions through deterministic card validation.)
