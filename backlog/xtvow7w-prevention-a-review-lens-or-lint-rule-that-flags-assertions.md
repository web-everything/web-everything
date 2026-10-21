---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/fixer-settings-1018.test.mjs", "we:scripts/settings/fix.json"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — A review lens or lint rule that flags assertions whose only subject is output the test itself pro… (from web-everything/web-everything#5615 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/fixer-settings-1018.test.mjs:24` — A review lens or lint rule that flags assertions whose only subject is output the test itself produced. Alternatively, make resolveFixSettings log all leaves through logCascadeSources so the test can assert on real resolver output.
2. `we:scripts/conveyor/__tests__/fixer-settings-1018.test.mjs:35` — Add named cases for built-in fallback, ignored platform preference, and each preserved routing path, then run them as a deterministic CI gate; alternatively reference existing named tests that assert these contracts.
3. `we:scripts/settings/fix.json:2` — Add deterministic resolver tests for absent settings and conflicting platform preferences, asserting both the resolved value and source.
4. `we:scripts/settings/fix.json:2` — Add a deterministic routing regression matrix covering the three exceptional paths with the threshold set to four.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5615@dfdc65892253631ef312eefb479f424f6dcf9827

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
