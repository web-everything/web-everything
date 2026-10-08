---
bornAs: x5lirwe
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog/task-agreement.mjs", "we:scripts/operations/codex-worker.mjs", "we:scripts/backlog/__tests__/task-agreement.test.mjs", "we:scripts/operations/__tests__/codex-worker.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a test rejects unknown policy keys with {mode:'advise', mdoe:'x'}, asserting a non-empty resu… (from web-everything/web-everything#4484 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog/task-agreement.mjs:46` — Add a test `rejects unknown policy keys` with `{mode:'advise', mdoe:'x'}`, asserting a non-empty result and that `$comment` alone is accepted. A general rule: every rejection branch in a validator needs one test case.
2. `we:scripts/backlog/task-agreement.mjs:118` — Treat an empty `item.text` as a dropped item with an `<section>-empty-item` problem, and add a test line to the 'drops TODO…' case.
3. `we:scripts/backlog/task-agreement.mjs:112` — Anchor the placeholder test to the leading `TODO:` (after an optional bold label) and add a test with a mid-sentence TODO that is kept.
4. `we:scripts/operations/codex-worker.mjs:72` — S7 should move codex-worker and the escape zones onto `ACCEPTANCE_HEADING_RE`/`NON_GOALS_HEADING_RE`. Until then, add a parity test that runs each heading spelling the reader accepts through every gate.
5. `we:scripts/backlog/task-agreement.mjs:135` — Add a deterministic unit test requiring empty numbered items to produce problems and remain absent from the returned agreement arrays.
6. `we:scripts/backlog/__tests__/task-agreement.test.mjs:173` — Add a deterministic policy-validation test combining a valid mode with an unknown key and asserting the unknown-key diagnostic.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4484@5065fa71a9bc6064e4fbe24bd4c8c2d74cc27da4

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
