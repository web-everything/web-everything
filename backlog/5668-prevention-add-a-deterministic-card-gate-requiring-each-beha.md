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
