---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6943-collector-seal-timeout-is-resumable-with-bounded-retries-the.md", "we:backlog/6942-collector-seal-numbers-every-member-before-the-pr-is-marked.md", "we:backlog/6948-collector-ruling-filer-routes-ruling-cards-into-the-ruling-s.md"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a check to the edge-case lint in 6939, or a card template line, so that a card which adds a '… (from web-everything/web-everything#5608 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6943-collector-seal-timeout-is-resumable-with-bounded-retries-the.md:17` — Add a check to the edge-case lint in 6939, or a card template line, so that a card which adds a 'held' terminal state must name its escalation case and its admission-unblock case.
2. `we:backlog/6943-collector-seal-timeout-is-resumable-with-bounded-retries-the.md:15` — Add a rule to the 6939 lint: a card that introduces a setting must state its default value, name a case that asserts it with no override, and have the settings file in its scope.
3. `we:backlog/6942-collector-seal-numbers-every-member-before-the-pr-is-marked.md:19` — The 6939 rule that makes ordering and recovery claims name a case could extend to any sentence containing 'leaves no' or 'never produces'.
4. `we:backlog/6948-collector-ruling-filer-routes-ruling-cards-into-the-ruling-s.md:22` — Add a test-plan convention: any card that validates an identifier shape must include a case for each accepted shape that exercises the downstream lookup. Enforce it in the 6939 lint if feasible.
5. `we:backlog/6948-collector-ruling-filer-routes-ruling-cards-into-the-ruling-s.md:57` — Add an edge-case lint rule (extending the one filed in 6939): a card that states a refusal guarantee for a gated entry must list a planned case for each bypass or alternate path into that entry, run at non-default values (priority, kind, caller). Alternatively, move the provenance check into `card-batch-file` so it runs before the bypass decision.
6. `we:backlog/6942-collector-seal-numbers-every-member-before-the-pr-is-marked.md:32` — Use a deterministic closure test matrix covering every supported reference field, both extraction directions, and transitive dependencies.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5608@ea579a278f11080e87ce859813dc0f3eaf0ee64f

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
