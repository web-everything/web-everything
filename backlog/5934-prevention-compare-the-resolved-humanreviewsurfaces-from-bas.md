---
bornAs: xsnygl7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/human-review-surfaces.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/__tests__/human-review-surfaces.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Compare the resolved humanReviewSurfaces from base and head platform-pref content, not hunk text.… (from web-everything/web-everything#5020 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/human-review-surfaces.mjs:78` — Compare the resolved humanReviewSurfaces from base and head platform-pref content, not hunk text. Or add a test with a multi-line array edited far from the key.
2. `we:scripts/operations/deliver-item-wrapper.mjs:2454` — Add a test that every scoreEscalation caller passes diffHunks, or make the settings floor degrade to the path-only check where hunks are structurally unavailable.
3. `we:scripts/check-standards.mjs:2864` — Put new check-standards rules in we:check-standards-rules.mjs with a unit test. A lint that flags inline `err(` loops in we:scripts/check-standards.mjs would make this deterministic.
4. `we:scripts/lib/human-review-surfaces.mjs:88` — Make any edit to these two preference files human-gated by path, or compare the parsed `humanReviewSurfaces` value at base against head. Add a test with a multi-line array edit whose hunk omits the key line.
5. `we:scripts/lib/human-review-surfaces.mjs:44` — For an invalid explicitly-set tool or env value, resolve to `broad` and log a warning. Alternatively, have check:standards validate the tool file's value. Add a test that an invalid explicit value does not yield `narrow`.
6. `we:scripts/check-standards.mjs:2860` — Add `we:scripts/lib/review-escalation.mjs` and `we:scripts/lib/policy-cascade.mjs` to the human-surface-setting floor. Alternatively, have the pin assert on the escalation reason rather than the boolean.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5020@03883fc95dfb10d9cc9d8af4c944f5e5d7bd281f

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
