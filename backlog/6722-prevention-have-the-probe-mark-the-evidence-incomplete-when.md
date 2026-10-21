---
bornAs: xf477yw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/__tests__/main-ci-red-io.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Have the probe mark the evidence incomplete when any non-summary failed job returns zero parsed f… (from web-everything/web-everything#5271 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-io.mjs:186` — Have the probe mark the evidence incomplete when any non-summary failed job returns zero parsed failures, or when more than two jobs failed, and make `classifyFlakeRun` require complete evidence. Add a regression test for the mixed-jobs case.
2. `we:scripts/conveyor/main-ci-red-io.mjs:190` — Add a deterministic probe regression test with three failed non-summary jobs, placing a non-flaky failure last and asserting flake eligibility is false; require complete evidence or decline signature-based eligibility.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5271@3db991e9d6b63b34631c9c89363b5f38603d60be

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
