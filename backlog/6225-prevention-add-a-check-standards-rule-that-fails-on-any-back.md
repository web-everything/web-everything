---
bornAs: xo12t0v
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xyzpgol-overlap-yield-known-holds.md", "we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/__tests__/overlap-yield-enqueueable.test.mjs", "we:scripts/conveyor/overlap-yield-enqueueable.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a check:standards rule that fails on any backlog card with status: active that still contains… (from web-everything/web-everything#5525 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/merge-ai-prs.mjs:4388` — Add a check:standards rule that fails on any backlog card with `status: active` that still contains `TODO` placeholders, plus a convention that each CLI-setting-log claim has a spawn-based smoke test.
2. `we:backlog/xyzpgol-overlap-yield-known-holds.md:28` — Add a write-gate in check:standards that requires each Acceptance line of an active card to reference a test file path and a test name. Add the same check to the card scaffolder's template.
3. `we:scripts/conveyor/__tests__/overlap-yield-enqueueable.test.mjs:7` — Add a test-review lens for settings with a default: require one test per call site that runs with the setting unset. Where possible, add a lint that flags tests that stub an env var in every case of a suite.
4. `we:scripts/conveyor/overlap-yield-enqueueable.mjs:32` — Add the named drain-level logging regression test to the required test gate, asserting both emission count and provenance content.
5. `we:scripts/conveyor/overlap-yield-enqueueable.mjs:32` — Add a deterministic drain-entry integration test asserting exactly one policy log with the resolved value and source per invocation.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5590, finding 4 → #5605, finding 6 → #5511, finding 8 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5525@19ac471fb5abba67a1853ab208020e75287a67e0

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
