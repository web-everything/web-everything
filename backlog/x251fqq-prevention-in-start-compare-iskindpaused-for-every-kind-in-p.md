---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/maintenance.mjs", "we:scripts/operations/maintenance-io.mjs", "we:scripts/operations/__tests__/maintenance.test.mjs", "we:scripts/operations/__tests__/maintenance-io.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — In start, compare isKindPaused for every kind in PAUSABLE_KINDS instead of paused. Add a fake-io… (from web-everything/web-everything#4173 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/maintenance.mjs:58` — In `start`, compare `isKindPaused` for every kind in `PAUSABLE_KINDS` instead of `paused`. Add a fake-io test with a scoped pause. A fidelity test using the real `dispatch-pause` state shape would also catch it.
2. `we:scripts/operations/maintenance.mjs:60` — Write the marker, including `prior`, first, then apply the pause and kill file. Add a test with a fake `writeMarker` that throws.
3. `we:scripts/operations/maintenance-io.mjs:33` — Add a test case where the fake claude exits 0 with non-matching output containing the sentinel as a substring. Compare the trimmed reply exactly, or match on a word boundary.
4. `we:scripts/operations/maintenance-io.mjs:31` — Add a deterministic real-subprocess test that exits zero with unexpected output and asserts that end throws and preserves the pause, kill file, and marker; include this branch in mutation checking.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4173@7c1cf1d3b5671b8d9f376d46809ea1140b367965

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
