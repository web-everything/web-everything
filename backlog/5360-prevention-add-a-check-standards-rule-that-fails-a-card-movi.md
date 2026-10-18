---
bornAs: xep9m9v
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a check:standards rule that fails a card moving from open to ready while its Done-when or Edg… (from web-everything/web-everything#4414 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md:26` — Add a check:standards rule that fails a card moving from open to ready while its Done-when or Edge-cases section still contains 'TODO:'.
2. `we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md:12` — Add a backlog validation gate requiring behavioral acceptance entries to specify a repository-qualified test file, planned case name, and observable assertion before preparation is complete.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4414@7551d840758044850fb35cf5ee8b7e557145c562

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

- Also raised by web-everything/web-everything#4988 (finding 1: `we:backlog/5919-drain-confirm-a-pr-is-merged-before-recording-it-as-landed.md:34` — Add a deterministic backlog validation gate requiring each behavioral edge-case requirement to reference a concrete planned test, repository-qualified file, and observable assertion.) · key `approval-prevention-key:web-everything/web-everything#4988@478e38ad58368f3169ae3e0d590ddabf1a67b0c5`
- Also raised by web-everything/web-everything#5304 (finding 1: `we:backlog/6135-daemon-smoke-dry-runs-get-their-own-gh-budget-or-a-recorded.md:30` — Add a deterministic backlog validation gate requiring each behavioral constraint to reference a planned test file, named case, and observable assertion; review whether those assertions actually establish the constraint.) · key `approval-prevention-key:web-everything/web-everything#5304@06d68c108737a620799e952941d591d703e9aed3`
- Also raised by web-everything/web-everything#5311 (finding 2: `we:backlog/6132-grouped-builds-a-single-digit-member-id-must-not-drop-resolu.md:12` — Add a card-validation gate requiring each behavioral acceptance constraint to reference a planned test file, named case, and observable assertion; review whether those assertions actually exercise each constraint.)
- Also raised by web-everything/web-everything#5341 (finding 2: `we:backlog/6139-review-clearance-guard-rollback-must-not-erase-a-fresh-opera.md:16` — Add a deterministic card-validation gate requiring behavioral acceptance requirements to reference a repository-qualified planned test file, named case, and observable assertion; the changed prevention card 5360 already tracks this guard.)
- Also raised by web-everything/web-everything#5351 (finding 2: `we:backlog/6140-soak-replay-gate-fail-a-pr-that-adds-a-soak-break-whose-fix.md:28` — Add a deterministic backlog validation rule requiring each behavioral edge-case guarantee to reference a repository-qualified test file, named planned case, and observable assertion.)
- Also raised by web-everything/web-everything#5513 (finding 2: `we:backlog/6209-red-team-setting-redteam-speculativebrief-independent-specul.md:16` — Add a deterministic preparation gate before cards become build-ready: reject TODO acceptance entries and require each behavioral requirement to reference a repository-qualified planned test file, named case and observable assertion, including omitted-setting cases for defaults.)
- Also raised by web-everything/web-everything#5485 (finding 9: `we:backlog/x7utze6-decide-codex-self-review-and-gate-per-caller-class.md:20` — Add a deterministic card-validation gate requiring each acceptance item to identify a test file, named case, and observable assertion; this guard needs a future backlog item.)
- Also raised by web-everything/web-everything#5485 (finding 11: `we:backlog/x7utze6-decide-codex-self-review-and-gate-per-caller-class.md:19` — Add a deterministic card-validation gate requiring each Acceptance guarantee to reference a repository-qualified test file, named case, and observable assertion.)
- Also raised by web-everything/web-everything#5509 (finding 3: `we:backlog/6199-prevention-add-a-card-lint-in-check-standards-that-every-mus.md:22` — At preparation, deterministically reject Acceptance entries without a repository-qualified test file, named case, and observable assertion; this belongs to the preparation-gate work already tracked in #5473.)
- Also raised by web-everything/web-everything#5521 (finding 3: `we:backlog/6216-prevention-a-pr-description-vs-diff-claim-check-on-behaviour.md:30` — Implement the card-validation gate tracked by #5360: at preparation, require each behavioral requirement to reference a repository-qualified planned test file, named case, and observable assertion, and reject TODO Acceptance placeholders. The diff records this future guard but does not demonstrate …)
- Also raised by web-everything/web-everything#5536 (finding 1: `we:backlog/x4pif3w-drain-prestage-cached-admission-must-not-survive-changes-to.md:19` — Add a check:standards rule that fails a card moving from filed to ready, or being picked up, while an [A#] line, N1, or an edge-case line still contains 'TODO:'. Preferably also block expedite-tagged cards with a TODO Acceptance.) · key `approval-prevention-key:web-everything/web-everything#5536@830ce7119fec44a34ac0dfaa3feb63159a53e27b`
- Also raised by web-everything/web-everything#5536 (finding 3: `we:backlog/x4pif3w-drain-prestage-cached-admission-must-not-survive-changes-to.md:16` — Add a deterministic card-validation gate requiring each acceptance ID to reference a repository-qualified test file, a named planned test, and an observable assertion, rejecting TODO-only acceptance entries.)
- Also raised by web-everything/web-everything#5536 (finding 4: `we:backlog/xtbxcp8-fix-scope-fence-human-review-send-back-header-must-not-disab.md:16` — Use the same deterministic card-validation gate to require a named planned test and observable assertion for every acceptance ID.)
- Also raised by web-everything/web-everything#5523 (finding 2: `we:backlog/6218-prevention-have-the-filer-qualify-the-reference-pr-finding-9.md:22` — Implement the validation gate already tracked by #5360 to require a repository-qualified planned test file, named case, and observable assertion before preparation completes; no executable gate is demonstrated here.)
- Also raised by web-everything/web-everything#5525 (finding 8: `we:backlog/xyzpgol-overlap-yield-known-holds.md:27` — Add a deterministic card-validation gate requiring each Acceptance ID to reference a repository-qualified test file and named implemented or planned case.)
- Also raised by web-everything/web-everything#5556 (finding 1: `we:backlog/xrv2a0x-prevention-a-filer-self-check-that-each-card-cited-as-record.md:22` — Implement the preparation gate already tracked in #5360: reject unresolved Acceptance TODOs and require a repository-qualified planned test file, named case, and observable assertion for each behavioral guarantee. No executable gate is demonstrated in this diff.)
- Also raised by web-everything/web-everything#5527 (finding 1: `we:backlog/6220-prevention-have-the-filer-generate-acceptance-lines-from-the.md:23` — Add a deterministic preparation gate rejecting TODO Acceptance and requiring each behavioral requirement to identify a repository-qualified test file, named planned case, and observable assertion; the referenced backlog cards already track this guard.) · key `approval-prevention-key:web-everything/web-everything#5527@54d7bceef9999bf46ae0ab4f186eceb9be730d27`
- Also raised by web-everything/web-everything#5554 (finding 3: `we:backlog/x9hf8a0-prevention-a-card-lint-requirement-that-a-card-widening-a-pe.md:24` — At preparation completion, deterministically reject unresolved Acceptance TODOs and require a repository-qualified test file, named case, and observable assertion for each acceptance guarantee.)
- Also raised by web-everything/web-everything#5533 (finding 2: `we:backlog/6226-prevention-add-a-check-standards-rule-on-backlog-cards-every.md:22` — Add a deterministic card-validation gate requiring executable Acceptance entries to reference a Test plan case with a repository-qualified file, case name, and observable assertion, rejecting TODO-only mappings.)
- Also raised by web-everything/web-everything#5539 (finding 1: `we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md:25` — Implement the already-recorded card-validation gate requiring each behavioral acceptance or edge-case guarantee to identify a repository-qualified test file, case name, and observable assertion before activation.) · key `approval-prevention-key:web-everything/web-everything#5539@3f757838dd923905ab25972e8947bdf5bb1c39b5`
- Also raised by web-everything/web-everything#5539 (finding 5: `we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md:26` — Add a deterministic card validation gate requiring executable Acceptance criteria to map to repository-qualified planned test files, named cases, and observable assertions before activation; related gate debt is already referenced, but this diff supplies no implemented gate.)
- Also raised by web-everything/web-everything#5546 (finding 11: `we:backlog/x2sgweq-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md:17` — Add a deterministic backlog validation gate requiring behavioral guarantee IDs to map to repository-qualified planned tests and observable assertions, including separate missing-value and invalid-value cases.)
- Also raised by web-everything/web-everything#5583 (finding 1: `we:backlog/6283-prevention-add-a-card-lint-check-that-every-planned-capabili.md:24` — Implement the preparation gate already tracked by #5473: reject activation unless every behavioral obligation maps to a repository-qualified test file, named planned case, and observable assertion.) · key `approval-prevention-key:web-everything/web-everything#5583@f3b9933a384fe3153685b5dd918ddbfe9871c3e5`
- Also raised by web-everything/web-everything#5528 (finding 4: `we:backlog/6222-drain-skip-reasons-report-real-enqueue-outcomes-not-ready-no.md:20` — Add a deterministic card-validation gate requiring each acceptance guarantee to reference a repository-qualified planned test file, named case, and observable assertion.)
- Also raised by web-everything/web-everything#5528 (finding 7: `we:backlog/6222-drain-skip-reasons-report-real-enqueue-outcomes-not-ready-no.md:20` — Add a deterministic card-validation gate requiring every behavioral guarantee to reference a repository-qualified test file, named case and observable assertion, allowing explicitly planned cases for preparation cards.)
- Also raised by web-everything/web-everything#5616 (finding 1: `we:backlog/xy2amdw-prevention-use-the-deterministic-guarantee-to-test-mapping-g.md:14` — Implement the preparation gate already tracked by #5360/#5473 to reject activation unless each behavioral guarantee maps to a repository-qualified planned test file, named case, and observable assertion.) · key `approval-prevention-key:web-everything/web-everything#5616@2cb1072fba68318494c2313911428f5dde975087`
