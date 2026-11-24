---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/__tests__/red-team-feed.test.mjs", "we:scripts/lib/red-team-feed.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a daemon-level test that drives cliReviewTickOpts().redTeamOnSkip with a finished-review PR a… (from web-everything/web-everything#7443 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:1652` — Add a daemon-level test that drives cliReviewTickOpts().redTeamOnSkip with a finished-review PR and asserts the queue entry. Longer term, a write-gate could require a test importing the host module whenever a diff adds an import to we:skills-src/conveyor/review-daemon.mjs.
2. `we:scripts/lib/__tests__/red-team-feed.test.mjs:34` — Review lens: for each guard clause in a pure planner, require one negative test that fails when that clause is removed. A mutation-testing gate over scripts/lib would catch this class deterministically.
3. `we:scripts/lib/__tests__/red-team-feed.test.mjs:55` — Add a lint/standards rule or review-lens check: every `catch { /* fail closed */ }` and defaulted guard in a conveyor lib needs a test that triggers it. Failing that, a mutation-testing run on scripts/lib/red-team-*.mjs.
4. `we:scripts/lib/__tests__/red-team-feed.test.mjs:32` — Add table-driven tests for each named exclusion, assert both tick results, and use a mutation gate for the eligibility predicates and logging key components.
5. `we:scripts/lib/red-team-feed.mjs:37` — Add boundary and reader-result cases, with mutation checks that remove the idle guard and weaken the explicit-false requirement.
6. `(no file cited)` — Require an acceptance-to-validation manifest checked by a deterministic gate, linking each operational criterion to a named measurement and each capacity constraint to an executable saturation test.
7. `we:scripts/lib/__tests__/red-team-feed.test.mjs:43` — Add a deterministic acceptance-mapping gate requiring every Acceptance criterion to identify a named check and its observable assertion, including operational measurement checks.
8. `we:scripts/lib/__tests__/red-team-feed.test.mjs:33` — Require a table-driven eligibility contract suite with explicit negative fixtures for every advertised exclusion and run targeted mutations against those guards.
9. `we:scripts/lib/red-team-feed.mjs:37` — Add a deterministic boundary-and-reader-result test matrix and targeted mutations for the strict timeout comparison and explicit-false requirement.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7443@fadf915caa92416d036107c7addb690115cc32ee

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
