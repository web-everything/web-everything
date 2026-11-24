---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-wrong-origin.test.mjs", "we:scripts/lib/lane-pool-origin.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/lib/__tests__/lane-pool-origin.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — For any change to an operator-facing diagnostic named in Acceptance, require a test that triggers… (from web-everything/web-everything#7419 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:1826` — For any change to an operator-facing diagnostic named in Acceptance, require a test that triggers the condition and asserts the message text. A standards lint could flag Acceptance bullets that name an output string with no matching `toMatch` in the PR's test files.
2. `we:scripts/lane-pool.mjs:1826` — Add a failing-probe fixture that asserts the real git error text appears in the note. A deterministic gate would be a standards check that every Acceptance bullet maps to a named test.
3. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:88` — Add a parameterised test over every command in the `needsOrigin` set that asserts 'no primary checkout' when the pool primary is absent.
4. `we:scripts/lane-pool.mjs:2511` — Add a lint or helper convention that existence probes must distinguish exit 1 from other failures. For example, a `refExists()` helper that returns true, false or throws, with a test for the error branch.
5. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs` — Add deterministic CLI tests named 'acquire grows from the selected pool origin across repositories' and 'acquire recovers from the selected pool origin across repositories', asserting the origin at the returned path.
6. `we:scripts/lib/lane-pool-origin.mjs:9` — Add a deterministic unit-test gate covering distinct local repository paths with and without the .git suffix.
7. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:95` — Gate the suite on named acquire tests that force growth and recovery from a foreign checkout and assert the resulting origin.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7419@6c83e215f8d10885e4a2eaa9756a2434f1d1114c

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
