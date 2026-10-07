---
bornAs: xv1nsx2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/merge-ai-prs-codeql-gate.test.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a revalidateForMerge case to the codeql-gate test file. A broader guard would be a parametris… (from web-everything/web-everything#4245 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/merge-ai-prs-codeql-gate.test.mjs:23` — Add a revalidateForMerge case to the codeql-gate test file. A broader guard would be a parametrised test that runs every merge-decision entry point over the same blocking-rollup fixtures.
2. `we:scripts/__tests__/merge-ai-prs-codeql-gate.test.mjs:43` — Read and parse we:scripts/drain-gate-settings.json directly in the test and assert the value is literally true.
3. `we:scripts/merge-ai-prs.mjs:431` — Add a unit test enumerating failing conclusions (FAILURE, TIMED_OUT, STARTUP_FAILURE, ERROR) and a capped-rollup case. Extend the existing capped-rollup resolver to also cover the CodeQL check name.
4. `we:scripts/merge-ai-prs.mjs:432` — Generalise the capped-rollup resolver to take a list of check names, and add a test with a 100+ row rollup where CodeQL is in the truncated tail. Alternatively, treat a rollup of 100 or more rows with no CodeQL row as unknown and park the PR.
5. `we:scripts/merge-ai-prs.mjs:434` — Decide explicitly whether CodeQL must be SUCCESS, NEUTRAL or SKIPPED. If so, block on any other terminal conclusion, and add table-driven tests over all conclusion values.
6. `we:scripts/__tests__/merge-ai-prs-codeql-gate.test.mjs:24` — Add an integration-style test through the re-read function with a stubbed freshPr. Alternatively, add a lint that flags classifyPr call sites that override gate knobs.
7. `we:scripts/__tests__/merge-ai-prs-codeql-gate.test.mjs:42` — Add an isolated configuration-to-classification integration test with the stored setting false and no blockOnCodeQL argument, and run it in the test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4245@082dff59e0a97d996f674377f223dcdde35b4724

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
