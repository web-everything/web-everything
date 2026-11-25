---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-fast-drain-listing.test.mjs", "we:scripts/lib/fast-drain-context.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/fast-drain-context.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Extract the OFF/ON option construction into a small pure function in we:fast-drain-scope.mjs or w… (from web-everything/web-everything#7518 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5934` — Extract the OFF/ON option construction into a small pure function in we:fast-drain-scope.mjs or we:scripts/lib/fast-drain-context.mjs, for example `fastDrainReadOptions({selfRefresh})`. Unit-test that OFF yields no ignoreDirty, ttlMs, targetMaxAgeMs or refreshSnapshot, then have main() call it.
2. `we:scripts/__tests__/merge-ai-prs-fast-drain-listing.test.mjs:665` — Have the test double write through to the readSnapshot double, so a refresh makes the next readSnapshot hit, then assert an exact refresh count. A cheaper alternative is to drop "once" from the acceptance wording.
3. `we:scripts/merge-ai-prs.mjs:5937` — Add a wiring test that runs the catch-up fast-drain path of main() with `selfRefresh` false and with it true. Have it spy on the readSharedOpenPrs and readFastDrainContext arguments, and assert that when OFF there is no `ignoreDirty`, no `ttlMs`, no `targetMaxAgeMs` and no `refreshSnapshot`. As a cheaper alternative, extract the option builder into a pure function in we:fast-drain-scope.mjs and unit-test it.
4. `(cited file withheld: not a plain path)` — Make the stub realistic: after refreshSnapshot runs, readSnapshot returns the refreshed rows. Then assert exactly one refresh per repo per round build. Alternatively, reword the acceptance to what is actually pinned.
5. `we:scripts/__tests__/merge-ai-prs-fast-drain-listing.test.mjs:674` — Gate changes with an exact per-repository refresh-count assertion for a stale-source round build.
6. `we:scripts/__tests__/merge-ai-prs-fast-drain-listing.test.mjs` — Add a deterministic integration test named 'default and explicit OFF preserve cache-only reader options' that observes production reader arguments and refresh/target-read counts.
7. `we:scripts/lib/fast-drain-context.mjs:231` — Make the named once-per-build test assert exactly one refresh per repository with a persistently unavailable cache reader, and enforce that budget across build stages.
8. `we:scripts/__tests__/merge-ai-prs-fast-drain-listing.test.mjs:762` — Add a production-wiring regression test with default and explicit OFF settings that asserts cacheOnly, normal TTL and dirty handling, no refresh callback, and no target reread bound.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7518@37d50f2c037a092597d0d7e03b96363b2195c274

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
