---
bornAs: xdtexv8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/sessions.mjs", "we:scripts/operations/sessions-io.mjs", "we:scripts/operations/__tests__/sessions-io-real.test.mjs", "we:scripts/operations/__tests__/sessions.test.mjs", "we:scripts/operations/__tests__/sessions-io.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a check:standards rule that fails a backlog card still containing 'TODO: the handling' in its… (from web-everything/web-everything#4399 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/sessions.mjs:165` — Add a check:standards rule that fails a backlog card still containing 'TODO: the handling' in its edge-case section before the PR is opened. In code, run a shared `isValidSessionSlug`-style validator and a length clamp at the reader boundary.
2. `we:scripts/operations/sessions-io.mjs:36` — Add a maximum `ended-within` clamp (for example 7d) in `parseWindow`. Add a stat-size check and a max-entries cap in `readJsonFiles`. Add a test that asserts the bytes read and the window clamp.
3. `we:scripts/operations/sessions.mjs:128` — Anchor the pattern as `^https://github\.com/...` and add a test with a foreign-host href.
4. `we:scripts/operations/sessions.mjs` — Add a deterministic regression test in we:scripts/operations/__tests__/sessions-history.test.mjs supplying both records and asserting exactly one review row.
5. `we:scripts/operations/sessions.mjs` — Add a deterministic reader-to-assembler regression test with out-of-range numeric timestamps, asserting that the operation completes and unrelated live and history rows remain available.
6. `we:scripts/operations/__tests__/sessions-io-real.test.mjs:38` — Instrument file reads in a deterministic test and assert that the ancient we:state.json path receives zero reads while an eligible file is read.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4399@0818c826d2839ee7f1d80d3ebd43c4dd4915c3b6

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
