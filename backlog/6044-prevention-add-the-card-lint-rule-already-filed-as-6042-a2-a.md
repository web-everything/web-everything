---
bornAs: xv52fve
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5967-decide-needs-a-human-before-review-and-reuse-a-same-head-rev.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add the card-lint rule already filed as #6042 (A2, A4): every pure-helper input in the Design sec… (from web-everything/web-everything#5156 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5967-decide-needs-a-human-before-review-and-reuse-a-same-head-rev.md:43` — Add the card-lint rule already filed as #6042 (A2, A4): every pure-helper input in the Design section must name a production source field. Add a wiring test that runs the park pass with the production net-file reader mocked at transport level, not an injected `earnedShape`. Pin the sites reuse applies to, or state that it applies to the `decideReviewGate` park only.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5156@e5ee0e906717c66c54457448c073406701c73a9b

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
