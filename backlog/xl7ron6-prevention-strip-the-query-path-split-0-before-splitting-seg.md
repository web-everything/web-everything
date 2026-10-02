---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-rest-read.mjs", "we:scripts/lib/__tests__/gh-rest-read.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Strip the query (path.split('?')[0]) before splitting segments, and add a slash-in-query case to the pr… (from chalbert/web-everything#3415 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-rest-read.mjs:110` — Strip the query (`path.split('?')[0]`) before splitting segments, and add a slash-in-query case to the `preserves valid endpoint` it.each.
2. `we:scripts/lib/gh-rest-read.mjs:110` — Add a test that pins the suffix policy, either rejecting dot-segments in the whole path or documenting that the suffix is trusted. Longer term, a check:standards rule flagging template-interpolated `repos/${...}` endpoints that bypass a shared builder.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3415@1df80664a3ec7f67cb7cb19ad1c5c35bf5c80966

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
