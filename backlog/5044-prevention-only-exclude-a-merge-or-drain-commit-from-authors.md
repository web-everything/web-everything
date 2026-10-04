---
bornAs: xjmbiaw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-need.mjs", "we:scripts/lib/__tests__/review-need.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Only exclude a merge or drain commit from authorship when it carries no author trailer and has an… (from web-everything/web-everything#3825 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-need.mjs:28` — Only exclude a merge or drain commit from authorship when it carries no author trailer and has an empty body. Alternatively, read parent counts and commit authors from the API instead of message text. Add a regression test for a spoofed merge headline carrying a Claude trailer. A review lens on provenance trust boundaries would also catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3825@99f38d10338dccb4154829aaf7f14a32dc380aac

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
