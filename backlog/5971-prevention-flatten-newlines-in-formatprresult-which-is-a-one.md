---
bornAs: xfb2frn
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-hold-class.mjs", "we:scripts/lib/__tests__/merge-gate-hold-class.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Flatten newlines in formatPrResult, which is a one-line fix in the producer. Add a producer test… (from web-everything/web-everything#5022 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-hold-class.mjs:23` — Flatten newlines in formatPrResult, which is a one-line fix in the producer. Add a producer test asserting every emitted table row is single-line for hostile reasons. Better, the shared parsePrResultTable that #5013 will consolidate should refuse tables where a header appears inside a row region.
2. `we:scripts/lib/merge-gate-hold-class.mjs:127` — Cache the parsed result (the table plus head_sha and completed_at) instead of the raw log, with a small LRU or size cap. A standards lint against module-level unbounded Map caches would also catch this class.
3. `we:scripts/lib/__tests__/merge-gate-hold-class.test.mjs:63` — Extend the deterministic settings test with platform-only off, repository off overriding platform on, and invalid platform/repository values beneath valid higher-priority overrides; assert both effective value and source.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5022@c408e037c4f6f661e0882e54fd8ae0aa3218716a

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
