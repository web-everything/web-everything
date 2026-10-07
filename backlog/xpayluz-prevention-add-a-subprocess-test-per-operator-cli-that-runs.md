---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/lib/main-staleness.mjs", "we:scripts/lib/__tests__/operator-cli-fresh.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/lib/__tests__/main-staleness.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a subprocess test per operator CLI that runs it with VITEST unset against a stale clone and a… (from web-everything/web-everything#4230 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-set-label.mjs:1904` — Add a subprocess test per operator CLI that runs it with `VITEST` unset against a stale clone and asserts the refusal marker. Alternatively, add a check:standards rule requiring each registered operator CLI to call `assertOperatorCliFresh`.
2. `we:scripts/lib/main-staleness.mjs:372` — Add a check:standards lint that flags `process.env.VITEST` in non-test `scripts/**` code outside an allowlisted helper, and add a spawn-the-CLI test that runs with `VITEST` unset.
3. `we:scripts/lib/main-staleness.mjs:378` — Add a unit test with a stubbed `run` where `rev-list` returns status 1 after a successful fetch, and have the helper return an explicit `unknown` state that fails closed.
4. `we:scripts/lib/__tests__/operator-cli-fresh.test.mjs:76` — Add deterministic integration tests invoking both real entrypoints from a stale fixture checkout with VITEST unset, asserting refusal before PR access; verify that removing each production call makes its test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4230@6bf622ff6ea9fefd4c6fb4fd278ddf5545bbd2b8

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
