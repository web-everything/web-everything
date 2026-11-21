---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs", "we:backlog/8681-detect-soak-marker-drift-after-reconcile-changes.md", "we:backlog/8683-harden-mechanical-tip-advisory-detection.md", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a unit test asserting that unknown trailer names and forged headlines do not establish mechan… (from web-everything/web-everything#7263 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/conveyor/reconcile-core.mjs:1645` — Add a unit test asserting that unknown trailer names and forged headlines do not establish mechanical provenance. Longer term, have conveyor producers sign the commit, or check commit author or committer identity (card 8683).
2. `we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs:209` — Add a write-gate or review lens that flags prose-only 'never/cannot' guarantees asserted solely through string matching. Add the execution-boundary test named in card 8682.
3. `we:backlog/8681-detect-soak-marker-drift-after-reconcile-changes.md:24` — Add named planned cases for complete detector enumeration, baseline absence versus regression, unreadable baseline/detector failures, and each chronology/fix-pushed marker omission; gate completion of the card on those deterministic tests.
4. `we:backlog/8683-harden-mechanical-tip-advisory-detection.md:21` — Specify named parameterized cases in we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs with expected dispatch/refusal assertions for trailer allowlisting, trusted and missing provenance, legitimate producers, deduplication, and retained gates; require the spoof case to fail when broad trailer acceptance is restored.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5590, finding 6 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7263@cb8f35f5dc834b5606a4429f8d62065fd5c09962

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
