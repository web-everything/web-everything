---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — A check:standards rule that sums a prepared card's slice-table sizes and compares the total to fr… (from web-everything/web-everything#4478 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md:1` — A check:standards rule that sums a prepared card's slice-table sizes and compares the total to frontmatter `size`.
2. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md:232` — A prepare-card lint requiring each non-n/a edge-case line to be cited by number from an Acceptance line, as the Must-cite rule already does for MVP Musts (#4438).
3. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md:141` — Add an A2 case: a draft-marked section run through prepareCardStatus under enforce must be not-agreed. Better, use a non-comment marker such as a visible `(draft)` suffix on the heading or a frontmatter flag.
4. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md:249` — Add a prepare-review rule or check:standards rule that each non-n/a edge-case row maps to an [A#] line naming a test.
5. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md:173` — Specify in S5 that the touch-set of the PR (backlog/ files and scope) must be consistent with the resolved card, or that an unresolved card on a build PR is logged and flagged to the juror. Add a test for that case.
6. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md` — Add a preparation-review check requiring syntax-only validation to use deterministic validators unless a concrete semantic requirement justifies model inference.
7. `we:backlog/5399-task-agreement-on-every-card-required-acceptance-and-non-goa.md` — Add deterministic refresh-runner tests covering each protected-card category and repeated validation failure, with write-spy and byte-preservation assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4478@a3850413b17d22999254ffaf74e76c8ae3ea59c8

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
