---
bornAs: xdstsoh
kind: story
size: 3
parent: "6236"
status: open
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 1 — closed finding-class list

Define the closed list of finding classes and map each onto the existing impact levels and dispositions, with a validator. Unknown class fails closed. Ruled in decision 6239.

## Acceptance

- [A1] **Executable** — validator test `class-mapping-complete` rejects a class without a valid existing impact/disposition mapping or with zero/multiple ratified table-row mappings, and accepts the ratified closed list. Pin its exact class tokens and each row mapping as independent expected literals; security classes map to the severity-partitioned security row and every always-block class stays invariant. Reject mappings to unknown rows or attempts to merge standards with lower-severity security. Slice 2 A13 expands every class through its mapped row at all levels.
- [A2] **Executable** — validator test `unknown-class-fails-closed` rejects unknown, missing, null, non-string and instruction-bearing class values, including case, whitespace, invisible-character and Unicode-lookalike variants of valid tokens; the ruling integration observes block for rejected values (slice 2 A8).
- [A3] **Executable** — validator test `class-list-unreadable` rejects missing, truncated, malformed and unreadable class-list input, with no default empty list or permissive mapping.

Ruling and amended table: [we:backlog/6239](/backlog/6239-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This slice defines class tokens and mappings; it does not implement settings writes, debt lifecycle or lessons.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — exact closed tokens only (A2); instructions in code, docs, config or data never extend the class list.
2. **Truncated reads** — no partial class list is accepted (A3).
3. **Shared state files** — n/a: this slice is a pure validator of immutable input; settings persistence belongs to slice 2 A11.
4. **Fail closed** — invalid mapping or class/list input refuses validation (A1–A3).
5. **Identity scoping** — n/a: this validator grants no edit authority; authenticated settings authority belongs to slice 2 A10.
6. **State over time** — n/a: class validation has no clock or mutable lifecycle.
7. **Who wrote it** — n/a: validation is identical for operator- and agent-supplied input; it authorizes no writes.

## Risks

Incomplete/ambiguous row mappings or normalized unknown tokens could weaken downstream outcomes (A1–A2); an unreadable list could be mistaken for no restrictions (A3).

## Test plan

Planned file `we:scripts/__tests__/review-stringency-classes.test.mjs` owns `class-mapping-complete`, `unknown-class-fails-closed` and `class-list-unreadable`, with the A1–A3 assertions above. Body-size, rate limit and origin `n/a:` for this pure local validator without an endpoint; production ingestion bounds and token-length cases are owned by slice 2 A8/A16 in `we:scripts/__tests__/review-stringency-ruling.test.mjs`. These are planned implementation files, not delivered tests.
