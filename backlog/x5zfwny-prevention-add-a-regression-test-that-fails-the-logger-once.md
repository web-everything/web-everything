---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-main-quarantine-io.mjs", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/lib/__tests__/fixtures/seat-checklist/security.rubric.json", "we:scripts/lib/__tests__/red-main-quarantine-io.test.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a regression test that fails the logger once and asserts exactly one wouldDo line after two t… (from web-everything/web-everything#7374 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-main-quarantine-io.mjs:620` — Add a regression test that fails the logger once and asserts exactly one `wouldDo` line after two ticks. Or set `shadowWhy` on append success alone, as before.
2. `we:scripts/lib/red-main-quarantine-io.mjs:342` — Add a test that runs `runSafetyNet` with the default policy reader against a temp or missing policy path, and a review-lens item: every doc sentence that names a fallback needs a test through the real default.
3. `we:scripts/lib/protected-path-floor.mjs:125` — Add a check:standards or unit gate that every settings file consumed by a merge or quarantine decision appears in the floor, or is explicitly exempt.
4. `we:scripts/lib/__tests__/fixtures/seat-checklist/security.rubric.json:4` — Have the fixture check reject `+we.worktree` versions in committed fixtures.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7374@7cf216c9cad0d7d325b7dd31b649b5eb3799e5fd

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
