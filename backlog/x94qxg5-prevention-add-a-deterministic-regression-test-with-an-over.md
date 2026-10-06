---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/related-test-selection.mjs", "we:scripts/lib/__tests__/related-test-selection.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a deterministic regression test with an over-limit readable hub and one direct importer whose… (from web-everything/web-everything#4138 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/related-test-selection.mjs:81` — Add a deterministic regression test with an over-limit readable hub and one direct importer whose reader throws EACCES; require the original related command. Propagate unexpected read errors to the fallback.
2. `we:scripts/lib/related-test-selection.mjs:28` — Add deterministic import-extraction and over-limit selection fixtures for comments between import tokens and dynamic-import options; use syntax-aware extraction or conservatively fall back when extraction is uncertain.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4138@1b16671dba409d7ea0ade65909ad48771266a573

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
