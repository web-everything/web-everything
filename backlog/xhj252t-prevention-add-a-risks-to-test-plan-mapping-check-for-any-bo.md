---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a Risks-to-Test-plan mapping check for any bounded read. Each one needs a test that asserts b… (from web-everything/web-everything#7601 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:356` — Add a Risks-to-Test-plan mapping check for any bounded read. Each one needs a test that asserts bytes read through an injected fs spy, not just a successful parse or hold.
2. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs` — For a bounded-read guarantee, require a test that spies on readSync or fstat and asserts the bytes-read ceiling, with a fixture that is valid when read unbounded. Add this as a test-plan lint in the card template, or as a mutation spot-check in review.
3. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs` — A review checklist item for compound guard predicates: one negative test per conjunct. A mutation-testing gate such as Stryker on we:scripts/conveyor/orphan-fix-round.mjs would catch this class automatically.
4. `we:scripts/conveyor/orphan-fix-round.mjs:303` — Add a deterministic test using attemptFs to record read ranges and enforce the aggregate byte budget across short reads.
5. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs` — Add a deterministic instrumented-filesystem test that rejects read requests exceeding the cumulative 65537-byte budget and run it in the standard test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7601@cc632962bc33039ca9119fdfcec0a2ed2f3d255c

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
