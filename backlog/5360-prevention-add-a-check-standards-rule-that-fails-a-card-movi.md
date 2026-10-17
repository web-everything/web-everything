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
- Also raised by web-everything/web-everything#5485 (finding 9: `we:backlog/x7utze6-decide-codex-self-review-and-gate-per-caller-class.md:20` — Add a deterministic card-validation gate requiring each acceptance item to identify a test file, named case, and observable assertion; this guard needs a future backlog item.)
- Also raised by web-everything/web-everything#5485 (finding 11: `we:backlog/x7utze6-decide-codex-self-review-and-gate-per-caller-class.md:19` — Add a deterministic card-validation gate requiring each Acceptance guarantee to reference a repository-qualified test file, named case, and observable assertion.)
