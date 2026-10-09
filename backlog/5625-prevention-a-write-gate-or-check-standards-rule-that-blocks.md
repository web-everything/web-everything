---
bornAs: xy2kgfz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5624-retries-carry-the-previous-attempt-failure-to-the-next-agent.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — A write-gate or check:standards rule that blocks a card moving from open to ready or build while… (from web-everything/web-everything#4644 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5624-retries-carry-the-previous-attempt-failure-to-the-next-agent.md:11` — A write-gate or check:standards rule that blocks a card moving from open to ready or build while any edge-case row is still TODO, and requires 'Untrusted text' to be non-TODO when the card describes passing text into an agent prompt.
2. `we:backlog/5624-retries-carry-the-previous-attempt-failure-to-the-next-agent.md:12` — Before implementation, require a claim-to-test review mapping each behavioral guarantee to a repository-qualified named test and observable assertion, including omitted-setting cases.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4644@050b84b1172ce30bf8fd3d7837148d995812d3d9

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
