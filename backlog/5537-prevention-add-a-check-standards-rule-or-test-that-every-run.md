---
bornAs: x46g7ur
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/red-green.mjs", "we:scripts/conveyor/prep-review.mjs", "we:scripts/conveyor/soak/__tests__/red-green.test.mjs", "we:scripts/conveyor/__tests__/prep-review.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule or test that every runtime-copy list (RUNTIME_PATHS, the sim template… (from web-everything/web-everything#4453 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/red-green.mjs:38` — Add a check:standards rule or test that every runtime-copy list (`RUNTIME_PATHS`, the sim template pathspec, and the test TREES lists) contains the directories that `import.meta.url`-relative file reads in `scripts/` resolve to. Better, derive those lists from one shared constant.
2. `we:scripts/conveyor/prep-review.mjs:78` — Have `prepareCardOnly` also require `changeType` ADDED or MODIFIED when the listing carries it, and treat an unknown change type as not-a-prepare-PR. Pin it with a rename test in we:prep-review.test.mjs. A lint that rejects path-only 'card-only' checks in conveyor modules would catch the class.
3. `we:scripts/conveyor/prep-review.mjs` — Extend the named test into a table-driven gate covering every existing review label, allowing review:prep and explicitly demonstrated stage-owned hold repairs while asserting zero model calls and writes for other labels.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4453@1aa98dd793035d37c16bdedd8c4a9b1ec15928a2

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
