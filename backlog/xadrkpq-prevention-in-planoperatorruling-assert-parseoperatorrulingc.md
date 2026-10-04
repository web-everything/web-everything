---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-referral-ruling.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/operations/__tests__/record-referral-ruling.test.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — In planOperatorRuling, assert parseOperatorRulingComment({body, author:{login:trusted}}).record i… (from web-everything/web-everything#3900 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-referral-ruling.mjs:113` — In planOperatorRuling, assert `parseOperatorRulingComment({body, author:{login:<trusted>}}).record` is returned before any post (or normalise/reject \r in reason). Add a test with a CRLF reason.
2. `we:scripts/lib/jury-core.mjs:2530` — Treat a malformed record from an untrusted author as ignorable noise, or as a hold only when a trusted author's comment is malformed. Add a test pinning whichever policy is chosen.
3. `we:scripts/lib/jury-core.mjs:2492` — Treat malformed records from untrusted authors as ignored plus a surfaced notice, and hold only for trusted-author malformed records. Add a test that an outsider's lookalike does not block the writer or the gate.
4. `we:scripts/lib/jury-core.mjs:2561` — Add a deterministic regression test passing a malformed operator comment through openReferralFindings into planOperatorRuling, asserting refusal before any post; return the combined referral and operator malformed state.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3900@cc49af8930a0d9094a7952475103f80008f70d7c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
