---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/fast-drain-scope.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add the two fallback CLI cases and a WE_FAST_DRAIN_LISTING=live case to the existing run() harnes… (from web-everything/web-everything#5316 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:4960` — Add the two fallback CLI cases and a `WE_FAST_DRAIN_LISTING=live` case to the existing `run()` harness. A branch-coverage threshold on merge-ai-prs listOne would catch the class.
2. `we:scripts/lib/enqueue-on-event.mjs:454` — Cap the buffer at a generous bound (e.g. 256 KB, keeping head and tail), or match the timings line incrementally with a line buffer. Add a test that feeds more than the cap and still extracts the timings. A lint rule against unbounded `+=` accumulation on child streams would catch the class.
3. `we:scripts/lib/__tests__/fast-drain-scope.test.mjs` — Add deterministic CLI tests injecting both failures and asserting successful live-listing fallback; include them in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5316@02f9dde83c5cd6ebc6e92d6601f95f46f2b6a846

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
