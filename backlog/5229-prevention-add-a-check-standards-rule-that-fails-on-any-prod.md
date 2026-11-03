---
bornAs: xitghab
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:bun-test.preload.ts", "we:scripts/lib/__tests__/under-test.test.mjs", "we:scripts/lib/__tests__/salvage-index.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs", "we:./__tests__/bun-test.preload.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a check:standards rule that fails on any production reference to env.VITEST or process.env.VI… (from web-everything/web-everything#4165 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:827` — Add a check:standards rule that fails on any production reference to env.VITEST or process.env.VITEST outside we:under-test.cjs. The backlog card 5152 already proposes a lint along these lines.
2. `we:bun-test.preload.ts:9` — Grep tests for direct env.VITEST reads when a runner marker changes, or expose a shared test-side helper that asserts isUnderTest().
3. `we:scripts/lib/__tests__/under-test.test.mjs:1` — Add a check:standards rule or an we:scripts/lib/__tests__/under-test.test.mjs source scan that rejects direct `VITEST` property reads (including optional-chaining and bracket forms) in production scripts/ and skills-src/ outside we:under-test.cjs.
4. `we:scripts/lib/__tests__/salvage-index.test.mjs:351` — Add a deterministic test that supplies a mocked populated default salvage store and asserts that no filesystem access occurs with WE_UNDER_TEST alone; require that test to fail when the early-return guard is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4165@f700b449e273826a8cddd417b75805f96bf6e963

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
