---
bornAs: xltx4lk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/_data/researchTopics/collector-pr-per-stream-card-batching.json", "we:backlog/6948-collector-ruling-filer-routes-ruling-cards-into-the-ruling-s.md", "we:backlog/6947-collector-declares-the-ruling-stream-disabled-and-folds-foll.md"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — A review-lens check that every summary claim about a set of systems is supported row by row in th… (from web-everything/web-everything#5608 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/_data/researchTopics/collector-pr-per-stream-card-batching.json:8` — A review-lens check that every summary claim about a set of systems is supported row by row in the description table. There is no cheap deterministic gate for this.
2. `we:backlog/6948-collector-ruling-filer-routes-ruling-cards-into-the-ruling-s.md:67` — Add a planned case in `we:card-batch-file.test.mjs`: with `ruling` enabled, a direct admission without a provenance token is refused. Or narrow edge case 7's wording to 'the ruling filer refuses'. The lasting guard is the edge-case lint rule in 6939: an 'X cannot Y' line must name a case at the enforcing layer.
3. `we:backlog/6947-collector-declares-the-ruling-stream-disabled-and-folds-foll.md:22` — Use a parameterized cascade test over the policy's configurable keys, asserting effective value and logged source for each; add a deterministic assertion that the test matrix covers every configurable key.
4. `we:backlog/6947-collector-declares-the-ruling-stream-disabled-and-folds-foll.md:21` — Add a deterministic policy test matrix covering neither threshold, count only, age only, and both thresholds.
5. `we:backlog/6947-collector-declares-the-ruling-stream-disabled-and-folds-foll.md:22` — Add a parameterized test over each supported stream and policy field, asserting a non-default effective override and its logged source.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5608@def18a9f3f27330e6b130fc7b98ef5cd16ca0b7b

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
