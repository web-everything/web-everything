---
bornAs: x8zjkbi
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog/edge-case-classes.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/backlog/__tests__/edge-case-classes.test.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Anchor the match to the numbered line prefix ^s*d+.s+**Label** and require non-trivial text after… (from web-everything/web-everything#4259 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog/edge-case-classes.mjs:57` — Anchor the match to the numbered line prefix `^\s*\d+\.\s+\*\*Label\*\*` and require non-trivial text after `n/a:`. Add negative-case tests for cross-label text and bare `n/a`.
2. `we:scripts/check-standards-rules.mjs:981` — Add one findGuardRelaxationGaps case to the existing lint tests: a relaxation card plus the scaffolded skeleton must still report missing-fail-closed. Longer term, a standards rule could require every new `break`/`continue` in a lint's scan loop to be cited by a test.
3. `we:scripts/backlog/edge-case-classes.mjs:56` — Validate that each matched class has a nonempty handling or a reason-bearing n/a answer, and add deterministic counter tests for label-only lines, empty answers, and bare n/a.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4259@62be52c1ebe13010e524ac0cb8a164b56862873e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
