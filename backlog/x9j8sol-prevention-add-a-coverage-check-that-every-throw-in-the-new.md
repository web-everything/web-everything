---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr-size-cap.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a coverage check that every throw in the new reader functions is reached by at least one name… (from web-everything/web-everything#5853 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/open-pr-io.mjs:175` — Add a coverage check that every `throw` in the new reader functions is reached by at least one named test. A per-file branch-coverage threshold on we:scripts/operations/open-pr-io.mjs would do it.
2. `we:scripts/operations/open-pr-io.mjs:170` — For any parser that handles several record shapes, require one fixture per shape. A review-lens checklist item is enough, since a script cannot decide it.
3. `we:scripts/operations/open-pr-io.mjs:199` — Add one it.each test over ['-x', '--output=f'] for base and sha, asserting a pr-size-unreadable refusal and zero git calls. A lint rule that flags a user-controlled string interpolated into execFileSync git args without a '--' or a leading-dash check would catch the class.
4. `we:scripts/operations/open-pr-io.mjs:196` — Add the fixture test above. Alternatively invert the default so the real reader is used unless the caller passes `diffStat: null`, with a lint rule that bans `() => ''` as a gate default.
5. `we:scripts/operations/__tests__/open-pr-size-cap.test.mjs:15` — Add a deterministic test using the runner's default diffStat selection, with underlying process operations mocked, asserting refusal and no submission for 301 non-test lines.
6. `we:scripts/operations/open-pr-io.mjs:164` — Add a deterministic regression test for a small modification to an existing attribute-marked production file, asserting both the measured added-plus-deleted count and successful admission.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5853@39b042d2b399833f1ab4279836c9ae2acbbd8b93

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
