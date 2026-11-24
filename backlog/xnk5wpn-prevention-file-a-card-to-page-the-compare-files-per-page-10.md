---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/check-timings-bot-only.mjs", "we:scripts/ci/__tests__/check-timings-bot-only.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — File a card to page the compare files (per_page=100, page loop, up to 3000) and reuse API_FILE_CA… (from web-everything/web-everything#7414 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/check-timings-bot-only.mjs:65` — File a card to page the compare files (per_page=100, page loop, up to 3000) and reuse API_FILE_CAP. Add a test for a 300–2999-file multi-page compare.
2. `we:scripts/ci/__tests__/check-timings-bot-only.test.mjs` — Add a named comparative regression test and require each numbered acceptance item to reference a named test in a deterministic acceptance-coverage check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7414@1955171dda94a883ceef5baafcb60c4d595d7c3a

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
