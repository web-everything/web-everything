---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — In soakCreatePrecheck, wrap the title read in try/catch (or read the raw sourceTitle) so a bad ti… (from web-everything/web-everything#4007 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-land.mjs:812` — In soakCreatePrecheck, wrap the title read in try/catch (or read the raw sourceTitle) so a bad title falls through to the existing create-time handling. Add a pr-land test for a bad-title create.
2. `we:scripts/pr-land.mjs:929` — Add a we:pr-land.test.mjs case with a stubbed forge and git for the three paths (refuse before push, existing-PR skip, diff-unavailable fail-open). Longer term, extract the create-precheck decision into an injectable function so it is unit-testable.
3. `we:scripts/pr-land.mjs:933` — Add a deterministic CLI integration test asserting refusal and zero publication calls, and verify that removing the refusal makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4007@09409f8f577f4099e3ef77749ec84f367aeabf9c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
