---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a lint or test helper that resolves every sandbox write root to an absolute path inside build… (from web-everything/web-everything#4359 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/deliver-item-wrapper.mjs:1275` — Add a lint or test helper that resolves every sandbox `write` root to an absolute path inside `buildNativeDenyCodexArgs`, and have wrapper tests clear `LANE_POOL_ROOT`.
2. `we:scripts/operations/deliver-item-wrapper.mjs:1282` — Add a test that sets `LANE_POOL_ROOT` to an unusual value, such as a relative path or one with `..`, and asserts the write entry is absolute and ends in `/.admission/heavy`. Better still, factor a shared `heavyAdmissionWritableRoot(lanePath)` helper that both Codex call sites use.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4359@384c61c25324d62fd04782ab899551171dc1e4a4

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
