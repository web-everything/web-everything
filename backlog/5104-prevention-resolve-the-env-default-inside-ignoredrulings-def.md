---
bornAs: xudgmgo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Resolve the env default inside ignoredRulings (default countInfraStalls = resolveCountInfraStalls… (from web-everything/web-everything#3915 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ruling-ledger.mjs:105` — Resolve the env default inside ignoredRulings (default `countInfraStalls = resolveCountInfraStalls()`) so every caller shares one source. Add a test that the knob flips the line-105 path too. I could not verify by mutation; the test that should redden is we:infra-stall-not-a-miss.test.mjs, and it has no case for this path.
2. `we:scripts/conveyor/fix-procedure.mjs:544` — Add a unit test for the (record.sessionId set, caller sessionId null) branch. Decide explicitly between falling back to the claimedAt timestamp check and failing closed.
3. `we:scripts/lib/ruling-ledger.mjs:260` — Add a bounded-exemption rule: count infra stalls on one sent-back head once N (e.g. 3) are reached, and add a unit test that asserts it. A broader review lens should flag any 'self-reported field suppresses a safety counter' pattern.
4. `we:scripts/conveyor/fix-procedure.mjs:551` — Add a deterministic parameterized test requiring rejection of sessionless records when claimedAt is missing or invalid, while accepting records newer than a valid claim timestamp.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3915@78cf4bc0eaac4230d59185f6d5484f063abf2758

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
