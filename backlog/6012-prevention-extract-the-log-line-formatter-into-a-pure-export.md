---
bornAs: xy13i1k
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs", "we:scripts/lib/build-queue.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Extract the log-line formatter into a pure exported function and test it. A coverage rule requiri… (from web-everything/web-everything#5017 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2455` — Extract the log-line formatter into a pure exported function and test it. A coverage rule requiring a named test for new daemon log contracts would be the deterministic gate.
2. `we:scripts/lib/__tests__/build-queue.test.mjs:500` — Add a build-queue test asserting that an uncleared listed card is never `next` and never takes a launch slot. A review-lens rule could also require each prose guarantee to map to a named test.
3. `we:scripts/lib/build-queue.mjs:370` — Warn when two cards claim the same alias (num, bornAs or x-id stem) in `check:standards`, so a collision is caught at authoring time.
4. `we:scripts/lib/build-queue.mjs:28` — Canonicalize numeric configuration IDs before deduplication and add a deterministic parameterized test covering padded IDs on either side, including inherited priority.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5017@12a9ad62c1facd86b837ee38346cc47c7fb18d82

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
