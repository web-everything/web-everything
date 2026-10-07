---
bornAs: xgd57i8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/shard-runner-compare.mjs", "we:scripts/ci/__tests__/shard-runner-compare.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a deterministic fetchShardJobs test with more than 100 jobs and a consequential rerun result… (from web-everything/web-everything#4181 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/shard-runner-compare.mjs:170` — Add a deterministic fetchShardJobs test with more than 100 jobs and a consequential rerun result on the second page, requiring pagination and correct aggregate statistics.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4181@03880434d7d7ebf6a2fb341b364c3e7f48514112

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
